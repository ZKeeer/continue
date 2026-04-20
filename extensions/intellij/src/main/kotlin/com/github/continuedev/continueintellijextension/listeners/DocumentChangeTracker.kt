package com.github.continuedev.continueintellijextension.listeners

import com.github.continuedev.continueintellijextension.autocomplete.ContinueInlineCompletionProvider
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import kotlinx.coroutines.*

/**
 * Tracks document changes to detect typing sessions and manage active handlers.
 */
@Service(Service.Level.PROJECT)
class DocumentChangeTracker(private val project: Project) : DocumentListener {

    companion object {
        private val LOG = Logger.getInstance(DocumentChangeTracker::class.java.simpleName)
    }

    private val coroutineScope = CoroutineScope(Dispatchers.Default.limitedParallelism(1) + SupervisorJob())
    private var typingHandler: TypingSessionHandler? = null
    private var typingSessionTimer: Job? = null

    private val TYPING_SESSION_TIMEOUT = 2000L // ms

    override fun documentChanged(event: DocumentEvent) {
        if (event.document.isWritable) {
            // Skip events caused by IntelliJ's dummy identifier insertion during completion context creation
            if (event.newFragment.contains("IntellijIdeaRulezzz") ||
                event.oldFragment.contains("IntellijIdeaRulezzz")) {
                return
            }
            // [zkdev] Send edit event to Core for unified QueueManager push
            sendEditEventToCore(event)
            handleDocumentChange()
        }
    }

    private fun handleDocumentChange() {
        val activeHandlerManager = project.service<ActiveHandlerManager>()

        // Cancel existing typing session timer
        typingSessionTimer?.cancel()

        // If no active handler or it's not already a typing session, create one
        val currentHandler = activeHandlerManager.getActiveHandler()
        if (currentHandler !is TypingSessionHandler) {
            typingHandler = TypingSessionHandler(project)
            activeHandlerManager.setActiveHandler(typingHandler!!)
        } else {
            // Update existing typing handler
            (currentHandler as TypingSessionHandler).updateTypingTime()
        }

        // Set up timer to clear typing session after inactivity
        typingSessionTimer = coroutineScope.launch {
            delay(TYPING_SESSION_TIMEOUT)

            // Clear typing handler if it's still active
            if (activeHandlerManager.isHandlerActive("typingSession")) {
                activeHandlerManager.clearActiveHandler()
                typingHandler?.dispose()
                typingHandler = null
            }
        }
    }

    fun dispose() {
        typingSessionTimer?.cancel()
        typingHandler?.dispose()
        coroutineScope.cancel()
    }

    /**
     * [zkdev] Send edit event to Core for unified QueueManager push.
     */
    private fun sendEditEventToCore(event: DocumentEvent) {
        try {
            val document = event.document
            val file = FileDocumentManager.getInstance().getFile(document) ?: return
            val filepath = file.url

            val startOffset = event.offset
            val endOffset = event.offset + event.newLength
            val startLine = document.getLineNumber(startOffset)
            val endLine = document.getLineNumber(endOffset)
            val startChar = startOffset - document.getLineStartOffset(startLine)
            val endChar = endOffset - document.getLineStartOffset(endLine)

            // [zkdev] Send only ±5 lines around edit instead of full document text
            val paddedStart = Math.max(0, startLine - 5)
            val paddedEnd = Math.min(document.lineCount - 1, endLine + 5)
            val localStartOffset = document.getLineStartOffset(paddedStart)
            val localEndOffset = document.getLineEndOffset(paddedEnd)
            val localContent = ContinueInlineCompletionProvider.stripDummyIdentifier(
                document.getText(com.intellij.openapi.util.TextRange(localStartOffset, localEndOffset))
            )

            val editAction = mapOf(
                "filepath" to filepath,
                "range" to mapOf(
                    "start" to mapOf("line" to startLine, "character" to startChar),
                    "end" to mapOf("line" to endLine, "character" to endChar)
                ),
                "fileContents" to localContent,
                "fileContentsBefore" to "",
                "editText" to event.newFragment.toString(),
                "beforeCursorPos" to mapOf("line" to startLine, "character" to startChar),
                "afterCursorPos" to mapOf("line" to endLine, "character" to endChar),
                "localContentStartLine" to paddedStart
            )

            val coreMessenger = project.service<com.github.continuedev.continueintellijextension.services.ContinuePluginService>().coreMessenger
            coreMessenger?.request("files/smallEdit", mapOf(
                "actions" to listOf(editAction)
            ), null) { }
        } catch (e: Exception) {
            LOG.debug("[zkdev] sendEditEventToCore failed: ${e.message}")
        }
    }
}