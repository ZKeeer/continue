package com.github.continuedev.continueintellijextension.`continue`

import com.github.continuedev.continueintellijextension.browser.ContinueBrowserService.Companion.getBrowser
import com.github.continuedev.continueintellijextension.constants.MessageTypes
import com.github.continuedev.continueintellijextension.`continue`.process.ContinueBinaryProcess
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

class CoreMessenger(
    private val project: Project,
    private val ideProtocolClient: IdeProtocolClient,
    val coroutineScope: CoroutineScope,
    private val onUnexpectedExit: () -> Unit,
    private val gsonService: GsonService = service<GsonService>(),
) {
    private val gson = gsonService.gson
    private val responseListeners = mutableMapOf<String, (Any?) -> Unit>()
    private var binaryProcess: ContinueBinaryProcess? = null
    private var process = startContinueProcess()
    private val log = Logger.getInstance(CoreMessenger::class.java.simpleName)

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
        // 使用 IPC (stdin/stdout) 模式 + abort 机制解决 Windows 阻塞问题
        // TCP 模式已回退：请求队列清理 + abort 信号传播可解决根本问题
        val isTcp = false
        
        val bp = ContinueBinaryProcess(onUnexpectedExit)
        binaryProcess = bp
        val continueProcess: ContinueProcess = if (isTcp) {
            ContinueSocketProcess.connectWithRetry()
        } else {
            bp
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