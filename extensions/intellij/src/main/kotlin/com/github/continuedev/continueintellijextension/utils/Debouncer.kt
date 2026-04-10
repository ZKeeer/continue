package com.github.continuedev.continueintellijextension.utils

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * [zkdev] Fixed debouncer: uses max(120ms, configDelay) as a pure debounce.
 *
 * With CompletionStreamer latest-only epoch control handling concurrent requests,
 * debounce only needs to merge millisecond-level consecutive keystrokes.
 * No adaptive logic needed — a fixed delay is simpler and more predictable.
 *
 * Previous adaptive 3-bucket logic is preserved below (commented out) for reference.
 */
class Debouncer(
    private val configDelay: Long,
    private val coroutineScope: CoroutineScope
) {
    private var debounceJob: Job? = null
    private var currentRequestId: String? = null

    // --- Preserved adaptive logic (no longer called) ---
    // private var lastKeystrokeTime: Long = 0
    // private val recentIntervals = LinkedList<Long>()
    //
    // companion object {
    //     private const val MAX_INTERVALS = 5
    // }
    //
    // /**
    //  * Adaptive debouncer: adjusts delay based on typing speed.
    //  * - Fast typing (<80ms between keystrokes) → longer delay (200ms) to avoid wasted requests
    //  * - Normal typing (80-200ms) → moderate delay (80ms)
    //  * - Pause/thinking (>200ms) → 120ms window to see if more keystrokes follow
    //  */
    // private fun getAdaptiveDelay(): Long {
    //     val now = System.currentTimeMillis()
    //     val interval = if (lastKeystrokeTime > 0) now - lastKeystrokeTime else Long.MAX_VALUE
    //     lastKeystrokeTime = now
    //
    //     recentIntervals.add(interval)
    //     if (recentIntervals.size > MAX_INTERVALS) {
    //         recentIntervals.removeFirst()
    //     }
    //
    //     val sorted = recentIntervals.sorted()
    //     val medianInterval = sorted[sorted.size / 2]
    //
    //     return when {
    //         medianInterval < 80 -> minOf(configDelay, 200)
    //         medianInterval < 200 -> minOf(configDelay, 80)
    //         else -> minOf(120, configDelay)
    //     }
    // }
    // --- End of preserved adaptive logic ---

    fun debounce(action: suspend () -> Unit) {
        val fixedDelay = maxOf(120L, configDelay)
        val requestId = UUID.randomUUID().toString()
        currentRequestId = requestId

        debounceJob?.cancel()
        debounceJob = coroutineScope.launch {
            delay(fixedDelay)
            // Only run if this is still the most recent request
            if (currentRequestId == requestId) {
                currentRequestId = null
                action()
            }
        }
    }
}