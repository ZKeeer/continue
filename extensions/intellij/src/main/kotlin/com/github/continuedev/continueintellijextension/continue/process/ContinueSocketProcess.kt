package com.github.continuedev.continueintellijextension.`continue`.process

import com.intellij.openapi.diagnostic.Logger
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.Socket

class ContinueSocketProcess private constructor(
    private val socket: Socket
) : ContinueProcess {

    override val input: InputStream = socket.getInputStream()
    override val output: OutputStream = socket.getOutputStream()
    private val log = Logger.getInstance(ContinueSocketProcess::class.java)

    override fun close() =
        socket.close()

    companion object {
        private const val BUFFER_SIZE = 8 * 1024 * 1024 // 8MB — agent mode can exchange large JSON messages
        private const val CONNECT_TIMEOUT_MS = 5000

        fun connectWithRetry(
            port: Int,
            maxRetries: Int = 10,
            retryIntervalMs: Long = 500
        ): ContinueSocketProcess {
            var lastException: ConnectException? = null
            val log = Logger.getInstance(ContinueSocketProcess::class.java)
            for (i in 1..maxRetries) {
                try {
                    val socket = Socket()
                    socket.sendBufferSize = BUFFER_SIZE
                    socket.receiveBufferSize = BUFFER_SIZE
                    socket.tcpNoDelay = true
                    socket.connect(java.net.InetSocketAddress("127.0.0.1", port), CONNECT_TIMEOUT_MS)
                    log.info("Connected to Core via TCP on port $port (buffer=${BUFFER_SIZE / 1024}KB)")
                    return ContinueSocketProcess(socket)
                } catch (e: ConnectException) {
                    lastException = e
                    log.info("TCP connection attempt $i/$maxRetries to port $port failed, retrying in ${retryIntervalMs}ms...")
                    Thread.sleep(retryIntervalMs)
                }
            }
            throw lastException ?: ConnectException("Failed to connect to Core TCP server on port $port after $maxRetries attempts")
        }
    }

}