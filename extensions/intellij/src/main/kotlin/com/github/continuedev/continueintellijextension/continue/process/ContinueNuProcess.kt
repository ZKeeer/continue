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
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission

/**
 * ContinueProcess implementation using NuProcess for non-blocking I/O.
 *
 * NuProcess uses IOCP on Windows, epoll on Linux, kqueue on macOS,
 * eliminating the 4KB anonymous pipe buffer bottleneck on Windows.
 *
 * The callback-based NuProcess API is adapted to InputStream/OutputStream
 * via PipedInputStream/PipedOutputStream (256KB buffer).
 */
class ContinueNuProcess(
    private val onUnexpectedExit: () -> Unit
) : ContinueProcess {

    companion object {
        private const val BUFFER_SIZE = 262144 // 256KB
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

    // Piped streams to adapt NuProcess callbacks to InputStream/OutputStream
    private val pipedOut = PipedOutputStream()
    private val pipedIn = PipedInputStream(pipedOut, BUFFER_SIZE)

    private val processHandler = object : NuAbstractProcessHandler() {
        override fun onStdout(buffer: ByteBuffer, closed: Boolean) {
            if (closed) {
                try { pipedOut.close() } catch (_: Exception) {}
                return
            }
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            try {
                pipedOut.write(bytes)
                pipedOut.flush()
            } catch (e: Exception) {
                log.warn("Error writing to piped stream", e)
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
            try { pipedOut.close() } catch (_: Exception) {}
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
        builder.setCwd(java.nio.file.Paths.get(path).parent)

        nuProcess = builder.start()
        log.info("Started core via NuProcess (buffer=${BUFFER_SIZE / 1024}KB)")
    }

    override val input: InputStream = pipedIn

    override val output: OutputStream = object : OutputStream() {
        override fun write(b: Int) {
            val buf = ByteBuffer.allocate(1)
            buf.put(b.toByte())
            buf.flip()
            nuProcess.writeStdin(buf)
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            val buf = ByteBuffer.wrap(b, off, len)
            nuProcess.writeStdin(buf)
        }

        override fun flush() {
            // NuProcess writeStdin is asynchronous, no explicit flush needed
        }

        override fun close() {
            nuProcess.closeStdin(false)
        }
    }

    override fun close() {
        nuProcess.destroy(false)
        try { pipedOut.close() } catch (_: Exception) {}
        try { pipedIn.close() } catch (_: Exception) {}
    }

    private fun reportErrorTelemetry(statusCode: Int) {
        val msg = "Core process (NuProcess) exited with code: $statusCode"
        service<ContinueSentryService>().reportMessage(msg)
        service<ContinuePostHogService>().capture("jetbrains_core_exit", mapOf("error" to msg))
    }
}
