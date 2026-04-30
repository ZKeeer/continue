package com.github.continuedev.continueintellijextension.`continue`.process

import com.github.continuedev.continueintellijextension.error.ContinuePostHogService
import com.github.continuedev.continueintellijextension.error.ContinueSentryService
import com.github.continuedev.continueintellijextension.proxy.ProxySettings
import com.github.continuedev.continueintellijextension.utils.OS
import com.github.continuedev.continueintellijextension.utils.getContinueBinaryPath
import com.github.continuedev.continueintellijextension.utils.getOS
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.zaxxer.nuprocess.NuAbstractProcessHandler
import com.zaxxer.nuprocess.NuProcess
import com.zaxxer.nuprocess.NuProcessBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission
import java.util.concurrent.LinkedBlockingQueue

private const val CR = '\r'.code.toByte()
private const val LF = '\n'.code.toByte()

/**
 * ContinueProcess implementation using NuProcess for non-blocking I/O.
 *
 * Uses IOCP (Windows), epoll (Linux), kqueue (macOS) via NuProcess.
 *
 * Optimized direct I/O — bypasses PipedStream entirely:
 * - Read: onStdout callback → byte-level line parsing → LinkedBlockingQueue<String>
 * - Write: batch messages → single writeStdin call with copied ByteBuffer
 *
 * Performance characteristics vs PipedStream adapter:
 * - Read: eliminates PipedStream synchronized lock per chunk; line parsing at byte level
 *   avoids CharsetDecoder overhead; non-blocking offer() never stalls NuProcess event thread
 * - Write: batch N messages into 1 writeStdin = 1 lock acquisition + 1 syscall (was N each)
 */
class ContinueNuProcess(
    private val onUnexpectedExit: () -> Unit
) : ContinueProcess {

    companion object {
        private const val BUFFER_SIZE = 8 * 1024 * 1024 // 8MB — agent mode can exchange large JSON messages
        private val log = Logger.getInstance(ContinueNuProcess::class.java)

        private fun setPermissions() {
            when (getOS()) {
                OS.MAC -> {
                    ProcessBuilder("xattr", "-dr", "com.apple.quarantine", getContinueBinaryPath())
                        .start().waitFor()
                    elevatePermissions()
                }
                OS.WINDOWS -> {}
                OS.LINUX -> elevatePermissions()
            }
        }

        private fun elevatePermissions() {
            val path = getContinueBinaryPath()
            val permissions = setOf(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE
            )
            Files.setPosixFilePermissions(Paths.get(path), permissions)
        }
    }

    /** Queue of complete JSON message lines (without \r\n delimiters).
     *  Consumed by ContinueProcessHandler read coroutine. */
    val messageQueue = LinkedBlockingQueue<String>()

    // Byte accumulator for line parsing — only accessed from NuProcess event thread (single-threaded)
    private var accBuf = ByteArray(BUFFER_SIZE)
    private var accLen = 0

    private val processHandler = object : NuAbstractProcessHandler() {
        override fun onStdout(buffer: ByteBuffer, closed: Boolean) {
            if (closed) {
                // Flush remaining partial line
                if (accLen > 0) {
                    val line = String(accBuf, 0, accLen, Charsets.UTF_8).trim()
                    if (line.isNotEmpty()) messageQueue.offer(line)
                    accLen = 0
                }
                return
            }

            // Append incoming bytes to accumulator
            val len = buffer.remaining()
            ensureCapacity(accLen + len)
            buffer.get(accBuf, accLen, len)
            accLen += len

            // Extract complete lines delimited by \r\n
            // Safe for UTF-8: \r (0x0D) and \n (0x0A) never appear inside multi-byte sequences
            var start = 0
            var i = 0
            while (i < accLen - 1) {
                if (accBuf[i] == CR && accBuf[i + 1] == LF) {
                    if (i > start) {
                        messageQueue.offer(String(accBuf, start, i - start, Charsets.UTF_8))
                    }
                    start = i + 2
                    i = start
                } else {
                    i++
                }
            }

            // Compact: move remaining bytes to front
            if (start > 0) {
                val remaining = accLen - start
                if (remaining > 0) {
                    System.arraycopy(accBuf, start, accBuf, 0, remaining)
                }
                accLen = remaining
            }
        }

        override fun onStderr(buffer: ByteBuffer, closed: Boolean) {
            if (closed) return
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            val text = String(bytes).trim()
            if (text.isNotEmpty()) {
                log.info("Core stderr: $text")
            }
        }

        override fun onExit(statusCode: Int) {
            log.info("NuProcess exited with code $statusCode")
            reportErrorTelemetry(statusCode)
            onUnexpectedExit()
        }
    }

    private val nuProcess: NuProcess

    init {
        val path = getContinueBinaryPath()
        runBlocking(Dispatchers.IO) { setPermissions() }

        val builder = NuProcessBuilder(processHandler, path)
        builder.environment() += ProxySettings.getSettings().toContinueEnvVars()
        builder.setCwd(Paths.get(path).parent)

        nuProcess = builder.start()
        log.info("Started core via NuProcess (buffer=${BUFFER_SIZE / 1024}KB, direct I/O)")
    }

    /**
     * Batch write multiple messages in a single writeStdin call.
     * Each message is terminated by \r\n.
     * Bytes are copied into a fresh array — safe for NuProcess async consumption.
     */
    fun writeMessages(messages: List<String>) {
        if (messages.isEmpty()) return
        val combined = buildString(messages.sumOf { it.length } + messages.size * 2) {
            for (msg in messages) {
                append(msg)
                append("\r\n")
            }
        }
        val bytes = combined.toByteArray(Charsets.UTF_8)
        nuProcess.writeStdin(ByteBuffer.wrap(bytes))
    }

    // InputStream/OutputStream for interface compliance — not used in optimized path
    override val input: InputStream = InputStream.nullInputStream()
    override val output: OutputStream = OutputStream.nullOutputStream()

    override fun close() {
        nuProcess.destroy(false)
    }

    private fun ensureCapacity(needed: Int) {
        if (needed > accBuf.size) {
            accBuf = accBuf.copyOf(maxOf(accBuf.size * 2, needed))
        }
    }

    private fun reportErrorTelemetry(statusCode: Int) {
        val msg = "Core process (NuProcess) exited with code: $statusCode"
        service<ContinueSentryService>().reportMessage(msg)
        service<ContinuePostHogService>().capture("jetbrains_core_exit", mapOf("error" to msg))
    }
}
