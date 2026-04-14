package com.github.continuedev.continueintellijextension.`continue`.process

import com.intellij.openapi.diagnostic.Logger
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.Socket

class ContinueSocketProcess : ContinueProcess {

    private val socket = Socket()
    override val input: InputStream
    override val output: OutputStream
    private val log = Logger.getInstance(ContinueSocketProcess::class.java)

    init {
        socket.sendBufferSize = 131072
        socket.receiveBufferSize = 131072
        socket.tcpNoDelay = true
        socket.connect(java.net.InetSocketAddress("127.0.0.1", 3000), 5000)
        input = socket.getInputStream()
        output = socket.getOutputStream()
        log.info("Connected to Core via TCP (buffer=128KB)")
    }

    override fun close() =
        socket.close()

    companion object {
        fun connectWithRetry(maxRetries: Int = 10, retryIntervalMs: Long = 500): ContinueSocketProcess {
            var lastException: ConnectException? = null
            val log = Logger.getInstance(ContinueSocketProcess::class.java)
            for (i in 1..maxRetries) {
                try {
                    return ContinueSocketProcess()
                } catch (e: ConnectException) {
                    lastException = e
                    log.info("TCP connection attempt $i/$maxRetries failed, retrying in ${retryIntervalMs}ms...")
                    Thread.sleep(retryIntervalMs)
                }
            }
            throw lastException ?: ConnectException("Failed to connect to Core TCP server after $maxRetries attempts")
        }
    }

}