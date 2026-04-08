package com.github.continuedev.continueintellijextension.listeners

import com.github.continuedev.continueintellijextension.nextEdit.NextEditService
import com.github.continuedev.continueintellijextension.nextEdit.NextEditStatusService
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import kotlinx.coroutines.*

/**
 * Interface for services that need to handle cursor movement events.
 */
interface CursorMovementHandler {
    val handlerId: String

    /**
     * Called when cursor moves while this handler is active.
     * @return true if the cursor movement was expected/handled, false otherwise
     */
    suspend fun onCursorMoved(editor: Editor, oldPosition: LogicalPosition?, newPosition: LogicalPosition): Boolean

    /**
     * Called when this handler becomes active.
     */
    fun onActivated() {}

    /**
     * Called when this handler is about to be deactivated.
     */
    fun onDeactivated() {}

    /**
     * Called when the handler should clean up its resources.
     */
    fun dispose() {
        onDeactivated()
    }
}

/**
 * Manages active cursor movement handlers to distinguish between intentional
 * cursor movements and side effects from various IDE operations.
 *
 * When a service is performing an operation that might move the cursor (like
 * accepting a completion, jumping, typing), it should register an active handler.
 * If no handler is active when the cursor moves, it's considered an intentional
 * movement and the next edit chain is deleted.
 */
@Service(Service.Level.PROJECT)
class ActiveHandlerManager(private val project: Project) : SelectionListener, CaretListener, DumbAware {

    companion object {
        private val LOG = Logger.getInstance(ActiveHandlerManager::class.java.simpleName)
        private const val CURSOR_DEBOUNCE_MS = 100L
    }

    private val coroutineScope = CoroutineScope(Dispatchers.Default.limitedParallelism(1) + SupervisorJob())
    private var activeHandler: CursorMovementHandler? = null
    private var isHandlingEvent = false
    private var cursorEventJob: Job? = null

    // Track last known cursor position to detect movements
    private var lastKnownPosition: LogicalPosition? = null
    private var lastKnownEditor: Editor? = null

    /**
     * Set an active handler for cursor movement events.
     * This should be called when a service is about to perform an operation
     * that might cause cursor movement.
     */
    fun setActiveHandler(handler: CursorMovementHandler) {
        clearActiveHandler()

        activeHandler = handler
        handler.onActivated()
    }

    /**
     * Clear the currently active handler.
     * This should be called when the operation is complete.
     */
    fun clearActiveHandler() {
        activeHandler?.let { handler ->
            handler.onDeactivated()
            handler.dispose()
        }
        activeHandler = null
    }

    /**
     * Get the currently active handler.
     */
    fun getActiveHandler(): CursorMovementHandler? = activeHandler

    /**
     * Check if a specific handler is currently active.
     */
    fun isHandlerActive(handlerId: String): Boolean {
        return activeHandler?.handlerId == handlerId
    }

    // SelectionListener implementation
    override fun selectionChanged(event: SelectionEvent) {
        if (isHandlingEvent || event.editor.isDisposed || !isNextEditEnabled()) return

        coroutineScope.launch {
            handleCursorMovement(event.editor, event.newRange.startOffset)
        }
    }

    // CaretListener implementation
    override fun caretPositionChanged(event: CaretEvent) {
        if (isHandlingEvent || event.editor.isDisposed || !isNextEditEnabled()) return

        coroutineScope.launch {
            handleCursorMovement(event.editor, event.caret?.offset ?: return@launch)
        }
    }

    private suspend fun handleCursorMovement(editor: Editor, offset: Int) {
        if (isHandlingEvent) return

        isHandlingEvent = true
        try {
            val currentPosition = editor.offsetToLogicalPosition(offset)
            val oldPosition = if (editor == lastKnownEditor) lastKnownPosition else null

            // Update tracking
            lastKnownPosition = currentPosition
            lastKnownEditor = editor

            // Skip if position hasn't actually changed
            if (oldPosition != null && oldPosition == currentPosition) {
                return
            }

            // [zkdev] Debounced: send cursor movement event to Core for unified QueueManager push
            cursorEventJob?.cancel()
            cursorEventJob = coroutineScope.launch {
                delay(CURSOR_DEBOUNCE_MS)
                sendCursorMovedEventToCore(editor, currentPosition)
            }

            val handler = activeHandler
            if (handler != null) {
                // A handler is active - let it decide if this movement was expected
                try {
                    val wasHandled = handler.onCursorMoved(editor, oldPosition, currentPosition)
                    if (!wasHandled) {
                        handleDeliberateCursorMovement()
                    }
                } catch (e: Exception) {
                    println("ActiveHandlerManager: Error in handler '${handler.handlerId}': ${e.message}")
                    // Treat as deliberate movement if handler fails
                    handleDeliberateCursorMovement()
                }
            } else {
                // No active handler - this is a deliberate cursor movement
                handleDeliberateCursorMovement()
            }
        } finally {
            isHandlingEvent = false
        }
    }

    private suspend fun handleDeliberateCursorMovement() {
        try {
            // Clear any active handler since the user moved the cursor deliberately
            clearActiveHandler()

            // Delete the next edit chain
            val nextEditService = project.getService(NextEditService::class.java)
            nextEditService.deleteChain()
        } catch (e: Exception) {
            println("ActiveHandlerManager: Error handling deliberate cursor movement: ${e.message}")
        }
    }

    private fun isNextEditEnabled() =
        project.service<NextEditStatusService>().isNextEditEnabled()

    /**
     * [zkdev] Send cursor movement event to Core for unified QueueManager push.
     */
    private fun sendCursorMovedEventToCore(editor: Editor, position: LogicalPosition) {
        try {
            val document = editor.document
            val file = FileDocumentManager.getInstance().getFile(document) ?: return
            val filepath = file.url
            
            // Calculate range around cursor (±30 lines like VSCode)
            val numSurroundingLines = 30
            val startLine = Math.max(0, position.line - numSurroundingLines)
            val endLine = Math.min(document.lineCount - 1, position.line + numSurroundingLines)
            
            // Extract content from document (in-memory, zero IO)
            val startOffset = document.getLineStartOffset(startLine)
            val endOffset = document.getLineEndOffset(endLine)
            val content = document.getText(TextRange(startOffset, endOffset)).trim()
            
            // Send to Core
            val coreMessenger = project.service<com.github.continuedev.continueintellijextension.services.ContinuePluginService>().coreMessenger
            coreMessenger?.request("files/cursorMoved", mapOf(
                "filepath" to filepath,
                "content" to content,
                "startLine" to startLine,
                "endLine" to endLine
            ), null) { }
        } catch (e: Exception) {
            LOG.debug("[zkdev] sendCursorMovedEventToCore failed: ${e.message}")
        }
    }

    fun dispose() {
        clearActiveHandler()
        coroutineScope.cancel()
    }
}