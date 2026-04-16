package com.github.continuedev.continueintellijextension.`continue`.process

import com.github.continuedev.continueintellijextension.error.ContinuePostHogService
import com.github.continuedev.continueintellijextension.error.ContinueSentryService
import com.github.continuedev.continueintellijextension.proxy.ProxySettings
import com.github.continuedev.continueintellijextension.utils.OS
import com.github.continuedev.continueintellijextension.utils.getContinueBinaryPath
import com.github.continuedev.continueintellijextension.utils.getOS
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission

class ContinueBinaryProcess(
    private val onUnexpectedExit: () -> Unit,
    private val useTcp: Boolean = false
) : ContinueProcess {

    private val process = startBinaryProcess()
    override val input: InputStream = process.inputStream
    override val output: OutputStream = process.outputStream

    /** In TCP mode, read the port number from binary's stderr "TCP_PORT:<port>" line. */
    var tcpPort: Int? = null
        private set

    override fun close() =
        process.destroy()

    private fun startBinaryProcess(): Process {
        val path = getContinueBinaryPath()
        runBlocking(Dispatchers.IO) {
            setPermissions()
        }

        val builder = ProcessBuilder(path)
        builder.environment() += ProxySettings.getSettings().toContinueEnvVars()
        if (useTcp) {
            builder.environment()["USE_TCP"] = "true"
        }
        val proc = builder
            .directory(File(path).parentFile)
            .start()
            .apply { onExit().thenRun(onUnexpectedExit).thenRun(::reportErrorTelemetry) }

        if (useTcp) {
            // Read TCP port from binary stderr (format: "TCP_PORT:<port>")
            tcpPort = readTcpPort(proc)
        }
        return proc
    }

    private fun readTcpPort(proc: Process): Int? {
        val log = Logger.getInstance(ContinueBinaryProcess::class.java)
        try {
            val reader = proc.errorStream.bufferedReader()
            val deadline = System.currentTimeMillis() + 10_000 // 10s timeout
            while (System.currentTimeMillis() < deadline) {
                if (!reader.ready()) {
                    Thread.sleep(50)
                    continue
                }
                val line = reader.readLine() ?: break
                if (line.startsWith("TCP_PORT:")) {
                    val port = line.substringAfter("TCP_PORT:").trim().toIntOrNull()
                    if (port != null) {
                        log.info("Core TCP server listening on port $port")
                        return port
                    }
                }
            }
            log.warn("Timed out waiting for TCP port from core binary")
        } catch (e: Exception) {
            log.warn("Error reading TCP port from core binary", e)
        }
        return null
    }

    private fun reportErrorTelemetry() {
        var err = process.errorStream?.bufferedReader()?.readText()?.trim()
        if (err != null) {
            // There are often "⚡️Done in Xms" messages, and we want everything after the last one
            val delimiter = "⚡ Done in"
            val doneIndex = err.lastIndexOf(delimiter)
            if (doneIndex != -1) {
                err = err.substring(doneIndex + delimiter.length)
            }
        }
        service<ContinueSentryService>().reportMessage("Core process exited with output: $err")
        service<ContinuePostHogService>().capture("jetbrains_core_exit", mapOf("error" to err))
    }

    private companion object {

        private fun setPermissions() {
            val os = getOS()
            when (os) {
                OS.MAC -> setMacOsPermissions()
                OS.WINDOWS -> {}
                OS.LINUX -> elevatePermissions()
            }
        }

        private fun setMacOsPermissions() {
            ProcessBuilder("xattr", "-dr", "com.apple.quarantine", getContinueBinaryPath()).start().waitFor()
            elevatePermissions()
        }

        // todo: consider setting permissions ahead-of-time during build/packaging, not at runtime
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

}