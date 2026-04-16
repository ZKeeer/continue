package com.github.continuedev.continueintellijextension.autocomplete

import com.github.continuedev.continueintellijextension.`continue`.ProfileInfoService
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.utils.castNestedOrNull
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.Duration.Companion.milliseconds

@Service(Service.Level.PROJECT)
class ContinueCompletionService(private val project: Project) : CompletionService {
    private var lastAutocompleteMessageId: String? = null

    override suspend fun getAutocomplete(uuid: String, url: String, line: Int, column: Int): String? {
        val requestInput = getCompletionInput(uuid, url, line, column)
        val messageId = "autocomplete-$uuid"
        lastAutocompleteMessageId = messageId
        val modelTimeout = project.service<ProfileInfoService>().fetchModelTimeoutOrNull() ?: 1000.0
        return try {
            withTimeoutOrNull(modelTimeout.milliseconds * 3) {
                suspendCancellableCoroutine { continuation ->
                    project.service<ContinuePluginService>().coreMessenger?.request(
                        "autocomplete/complete",
                        requestInput,
                        messageId
                    ) {
                        val content = it.castNestedOrNull<List<String>>("content")?.firstOrNull() ?: ""
                        if (continuation.isActive) {
                            continuation.resumeWith(Result.success(content))
                        }
                    }
                    continuation.invokeOnCancellation {
                        sendAbort(messageId)
                    }
                }
            } ?: run {
                sendAbort(messageId)
                null
            }
        } catch (e: CancellationException) {
            sendAbort(messageId)
            null
        }
    }

    override fun acceptAutocomplete(uuid: String?) {
        project.service<ContinuePluginService>().coreMessenger?.request(
            "autocomplete/accept",
            mapOf("completionId" to uuid),
            null
        ) {}
    }

    override fun cancelAutocomplete() {
        val msgId = lastAutocompleteMessageId
        if (msgId != null) {
            sendAbort(msgId)
            lastAutocompleteMessageId = null
        }
        // [zkdev] Plan B: Only abort by messageId, do NOT send autocomplete/cancel.
        // autocomplete/cancel calls CompletionProvider.cancel() which clears ALL
        // abort controllers (including cache/prefetch), hurting cache hit rates.
        // By only aborting the specific messageId, Core stops LLM + IPC for that
        // request but preserves internal caches for subsequent completions.
    }

    private fun sendAbort(messageId: String) {
        project.service<ContinuePluginService>().coreMessenger?.request(
            "abort",
            mapOf("messageId" to messageId),
            null
        ) {}
    }

    private fun getCompletionInput(uuid: String, filepath: String, line: Int, character: Int): Map<String, *> = mapOf(
        "completionId" to uuid,
        "filepath" to filepath,
        "pos" to mapOf(
            "line" to line,
            "character" to character
        ),
        "clipboardText" to "",
        "recentlyEditedRanges" to emptyList<Any>(),
        "recentlyVisitedRanges" to emptyList<Any>(),
    )

}