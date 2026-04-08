package com.github.continuedev.continueintellijextension.utils

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.LinkedList

/**
 * [zkdev] Adaptive debouncer: adjusts delay based on typing speed.
 * Mirrors VS Code's AutocompleteDebouncer.ts behavior:
 * - Fast typing (<80ms between keystrokes) → longer delay (200ms) to avoid wasted requests
 * - Normal typing (80-200ms) → moderate delay (80ms)
 * - Pause/thinking (>200ms) → 120ms window to see if more keystrokes follow
 */
class Debouncer(
    private val configDelay: Long,
    private val coroutineScope: CoroutineScope
) {
    private var debounceJob: Job? = null
    private var currentRequestId: String? = null
    private var lastKeystrokeTime: Long = 0
    private val recentIntervals = LinkedList<Long>()

    companion object {
        private const val MAX_INTERVALS = 5
    }

    private fun getAdaptiveDelay(): Long {
        val now = System.currentTimeMillis()
        val interval = if (lastKeystrokeTime > 0) now - lastKeystrokeTime else Long.MAX_VALUE
        lastKeystrokeTime = now

        // Track recent intervals (sliding window)
        recentIntervals.add(interval)
        if (recentIntervals.size > MAX_INTERVALS) {
            recentIntervals.removeFirst()
        }

        // Calculate median interval for stability
        val sorted = recentIntervals.sorted()
        val medianInterval = sorted[sorted.size / 2]

        return when {
            medianInterval < 80 -> minOf(configDelay, 200)   // Fast typing → batch
            medianInterval < 200 -> minOf(configDelay, 80)   // Normal typing
            else -> minOf(120, configDelay)                    // Pause → 120ms window
        }
    }

    fun debounce(action: suspend () -> Unit) {
        val adaptiveDelay = getAdaptiveDelay()
        val requestId = UUID.randomUUID().toString()
        currentRequestId = requestId

        debounceJob?.cancel()
        debounceJob = coroutineScope.launch {
            delay(adaptiveDelay)
            // Only run if this is still the most recent request
            if (currentRequestId == requestId) {
                currentRequestId = null
                action()
            }
        }
    }
}