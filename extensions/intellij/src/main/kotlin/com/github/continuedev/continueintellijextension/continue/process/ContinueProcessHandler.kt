package com.github.continuedev.continueintellijextension.`continue`.process

import com.github.continuedev.continueintellijextension.error.ContinueSentryService
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.*
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter

class ContinueProcessHandler(
    parentScope: CoroutineScope,
    private val process: ContinueProcess,
    handleMessage: (String) -> (Unit)
) {
    private val innerJob = Job()
    private val scope = CoroutineScope(parentScope.coroutineContext + innerJob)
    private val writeQueue = ArrayDeque<String>()
    private val queueLock = Any()
    private val log = Logger.getInstance(ContinueProcessHandler::class.java)

    // Stream-based I/O — only created for non-NuProcess
    private val writer: OutputStreamWriter?
    private val reader: BufferedReader?

    init {
        if (process is ContinueNuProcess) {
            writer = null
            reader = null
            initDirectIO(process, handleMessage)
        } else {
            writer = OutputStreamWriter(process.output)
            reader = BufferedReader(InputStreamReader(process.input), 262144) // 256KB buffer
            initStreamIO(handleMessage)
        }
    }

    /**
     * NuProcess optimized path — no PipedStream, no BufferedReader/OutputStreamWriter.
     * Read: take complete lines from messageQueue (parsed in onStdout callback)
     * Write: batch all queued messages into a single writeStdin call
     */
    private fun initDirectIO(nuProcess: ContinueNuProcess, handleMessage: (String) -> Unit) {
        // Reader coroutine: take from LinkedBlockingQueue (blocks until line available)
        scope.launch(Dispatchers.IO) {
            try {
                while (isActive) {
                    val line = nuProcess.messageQueue.take()
                    if (line.isNotEmpty()) {
                        try {
                            log.debug("Handle: $line")
                            handleMessage(line)
                        } catch (e: Exception) {
                            service<ContinueSentryService>().report(e, "Error handling message: $line")
                        }
                    }
                }
            } catch (_: InterruptedException) {
                // Normal shutdown — coroutine cancellation interrupts take()
            }
        }

        // Writer coroutine: batch all queued messages → single writeMessages call
        scope.launch(Dispatchers.IO) {
            while (isActive) {
                val messages: List<String>
                synchronized(queueLock) {
                    while (writeQueue.isEmpty() && isActive) {
                        (queueLock as java.lang.Object).wait(100)
                    }
                    messages = writeQueue.toList()
                    writeQueue.clear()
                }
                if (messages.isNotEmpty()) {
                    try {
                        log.debug("Batch write ${messages.size} messages")
                        nuProcess.writeMessages(messages)
                    } catch (e: Exception) {
                        log.warn("Write error", e)
                    }
                }
            }
        }
    }

    /**
     * Traditional stream path — for ContinueBinaryProcess / ContinueSocketProcess.
     * Uses BufferedReader for reads, OutputStreamWriter for writes.
     */
    private fun initStreamIO(handleMessage: (String) -> Unit) {
        scope.launch(Dispatchers.IO) {
            try {
                while (isActive) {
                    val line = reader!!.readLine()
                    if (line != null && line.isNotEmpty()) {
                        try {
                            log.debug("Handle: $line")
                            handleMessage(line)
                        } catch (e: Exception) {
                            service<ContinueSentryService>().report(e, "Error handling message: $line")
                        }
                    } else if (line == null) {
                        break // EOF — process closed
                    }
                }
            } catch (e: IOException) {
                service<ContinueSentryService>().report(e)
            }
        }
        scope.launch(Dispatchers.IO) {
            while (isActive) {
                val messages: List<String>
                synchronized(queueLock) {
                    while (writeQueue.isEmpty() && isActive) {
                        (queueLock as java.lang.Object).wait(100)
                    }
                    messages = writeQueue.toList()
                    writeQueue.clear()
                }
                for (message in messages) {
                    try {
                        log.debug("Write: $message")
                        writer!!.write(message)
                        writer.write("\r\n")
                        writer.flush()
                    } catch (e: IOException) {
                        log.warn(e)
                    }
                }
            }
        }
    }

    fun write(message: String) {
        synchronized(queueLock) {
            writeQueue.addLast(message)
            (queueLock as java.lang.Object).notifyAll()
        }
    }

    /**
     * Only clear autocomplete-related messages from write queue.
     * Other messages (e.g., config/readFile responses) must NOT be cleared,
     * otherwise config loading will timeout.
     */
    fun clearAutocompleteWrites() {
        synchronized(queueLock) {
            val autocompletePatterns = listOf("autocomplete", "nextEdit")
            val originalSize = writeQueue.size
            val retained = writeQueue.filter { msg ->
                // Keep messages that are NOT autocomplete-related
                !autocompletePatterns.any { pattern -> msg.contains(pattern) }
            }
            val removed = originalSize - retained.size
            if (removed > 0) {
                writeQueue.clear()
                retained.forEach { writeQueue.addLast(it) }
                log.info("Cleared $removed autocomplete writes from queue (kept ${retained.size})")
            }
            (queueLock as java.lang.Object).notifyAll()
        }
    }

    fun close() {
        innerJob.cancel()
        synchronized(queueLock) {
            (queueLock as java.lang.Object).notifyAll()
        }
        scope.launch(Dispatchers.IO) {
            reader?.close()
            writer?.close()
            process.close()
        }
    }
}