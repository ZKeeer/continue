package com.github.continuedev.continueintellijextension.`continue`

import com.github.continuedev.continueintellijextension.browser.ContinueBrowserService.Companion.getBrowser
import com.github.continuedev.continueintellijextension.constants.MessageTypes
import com.github.continuedev.continueintellijextension.`continue`.process.ContinueBinaryProcess
import com.github.continuedev.continueintellijextension.`continue`.process.ContinueNuProcess
import com.github.continuedev.continueintellijextension.`continue`.process.ContinueProcess
import com.github.continuedev.continueintellijextension.`continue`.process.ContinueProcessHandler
import com.github.continuedev.continueintellijextension.`continue`.process.ContinueSocketProcess
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.services.GsonService
import com.github.continuedev.continueintellijextension.utils.uuid
import com.google.gson.JsonSyntaxException
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CoroutineScope

enum class IpcMode {
    NUPROCESS,  // Default: NuProcess with IOCP/epoll/kqueue
    TCP         // TCP loopback with dynamic port negotiation
}

class CoreMessenger(
    private val project: Project,
    private val ideProtocolClient: IdeProtocolClient,
    val coroutineScope: CoroutineScope,
    private val onUnexpectedExit: () -> Unit,
    private val gsonService: GsonService = service<GsonService>(),
) {
    private val log = Logger.getInstance(CoreMessenger::class.java.simpleName)
    private val gson = gsonService.gson
    private val responseListeners = mutableMapOf<String, (Any?) -> Unit>()
    private var binaryProcess: ContinueBinaryProcess? = null
    private var process = startContinueProcess()

    private val autocompletePrefixes = listOf("autocomplete-", "nextEdit-")
    private val ideRequestPrefixes = listOf("readFile", "getWorkspace", "getDocument", "getDiff", "getRepo", "getIde", "listDir", "getFile", "getGit", "getBranch")

    fun request(messageType: String, data: Any?, messageId: String?, onResponse: (Any?) -> Unit) {
        val id = messageId ?: uuid()

        if (messageType == "autocomplete/complete" || messageType == "nextEdit/predict") {
            val staleIds = responseListeners.keys.filter { key ->
                autocompletePrefixes.any { prefix -> key.startsWith(prefix) }
            }
            staleIds.forEach { staleId ->
                responseListeners.remove(staleId)
            }
            // [zkdev] Only clear autocomplete-related IDE requests, not all
            // cancelPendingIdeRequests cancels ALL pending requests including config loading!
            // process.clearAutocompleteWrites() // Disabled: write queue should not be cleared
            // The abort mechanism in Core side handles autocomplete cancellation properly
        }

        val message = gson.toJson(mapOf("messageId" to id, "messageType" to messageType, "data" to data))
        responseListeners[id] = onResponse
        process.write(message)
    }

    private fun startContinueProcess(): ContinueProcessHandler {
        val ipcMode = IpcMode.valueOf(
            System.getenv("CONTINUE_IPC_MODE")?.uppercase() ?: "NUPROCESS"
        )
        log.info("Starting Continue process with IPC mode: $ipcMode")

        val continueProcess: ContinueProcess = when (ipcMode) {
            IpcMode.TCP -> {
                val bp = ContinueBinaryProcess(onUnexpectedExit, useTcp = true)
                binaryProcess = bp
                val port = bp.tcpPort
                    ?: throw IllegalStateException("Failed to get TCP port from core binary")
                ContinueSocketProcess.connectWithRetry(port)
            }
            IpcMode.NUPROCESS -> {
                try {
                    log.info("Attempting to start Core with NuProcess")
                    ContinueNuProcess(onUnexpectedExit)
                } catch (e: Exception) {
                    log.warn("NuProcess failed, falling back to standard pipe IPC", e)
                    val bp = ContinueBinaryProcess(onUnexpectedExit)
                    binaryProcess = bp
                    bp
                }
            }
        }
        return ContinueProcessHandler(coroutineScope, continueProcess, ::handleMessage)
    }

    private fun handleMessage(json: String) {
        val responseMap = tryToParse(json) ?: return
        val messageId = responseMap["messageId"].toString()
        val messageType = responseMap["messageType"].toString()
        val data = responseMap["data"]

        // IDE listeners
        if (messageType in MessageTypes.IDE_MESSAGE_TYPES) {
            ideProtocolClient.handleMessage(json) { data ->
                val message = gson.toJson(mapOf("messageId" to messageId, "messageType" to messageType, "data" to data))
                process.write(message)
            }
        }

        // Forward to webview
        if (messageType in MessageTypes.PASS_THROUGH_TO_WEBVIEW) {
            project.getBrowser()?.sendToWebview(messageType, responseMap["data"], messageId)
        }

        // Responses for messageId
        responseListeners[messageId]?.let { listener ->
            listener(data)
            @Suppress("UNCHECKED_CAST")
            val done = (data as? Map<String, Any>)?.get("done") as? Boolean

            // Remove unless explicitly streaming (done == false)
            if (done != false) {
                responseListeners.remove(messageId)
            }
        }
    }

    // todo: map<*, *> = code smell
    private fun tryToParse(json: String): Map<*, *>? =
        try {
            gson.fromJson(json, Map::class.java)
        } catch (_: JsonSyntaxException) {
            log.warn("Invalid message JSON: $json") // example: NODE_ENV undefined
            null
        }

    fun restart() {
        log.warn("Restarting Continue process")
        responseListeners.clear()
        process.close()
        binaryProcess?.close()
        binaryProcess = null
        process = startContinueProcess()
    }

    fun close() {
        log.warn("Closing Continue process")
        process.close()
        binaryProcess?.close()
        binaryProcess = null
    }
}