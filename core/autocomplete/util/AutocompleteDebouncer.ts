import { v4 as uuidv4 } from "uuid";

/**
 * [zkdev] Adaptive debouncer: adjusts delay based on typing speed.
 * - Fast typing (<80ms between keystrokes) → longer delay (150-200ms) to avoid wasted requests
 * - Normal typing (80-200ms) → moderate delay (80ms)
 * - Pause/thinking (>200ms) → short delay (30ms) for instant response
 */
export class AutocompleteDebouncer {
  private debounceTimeout: NodeJS.Timeout | undefined = undefined;
  private currentRequestId: string | undefined = undefined;
  private lastKeystrokeTime: number = 0;
  private recentIntervals: number[] = [];
  private static readonly MAX_INTERVALS = 5;

  private getAdaptiveDelay(configDelay: number): number {
    const now = Date.now();
    const interval = this.lastKeystrokeTime > 0 ? now - this.lastKeystrokeTime : Infinity;
    this.lastKeystrokeTime = now;

    // Track recent intervals (sliding window)
    this.recentIntervals.push(interval);
    if (this.recentIntervals.length > AutocompleteDebouncer.MAX_INTERVALS) {
      this.recentIntervals.shift();
    }

    // Calculate median interval for stability
    const sorted = [...this.recentIntervals].sort((a, b) => a - b);
    const medianInterval = sorted[Math.floor(sorted.length / 2)];

    if (medianInterval < 80) {
      // Fast typing → longer delay to batch requests
      return Math.min(configDelay, 200);
    } else if (medianInterval < 200) {
      // Normal typing
      return Math.min(configDelay, 80);
    } else {
      // Paused → respond quickly
      return 30;
    }
  }

  async delayAndShouldDebounce(debounceDelay: number): Promise<boolean> {
    const adaptiveDelay = this.getAdaptiveDelay(debounceDelay);

    // Generate a unique ID for this request
    const requestId = uuidv4();
    this.currentRequestId = requestId;

    // Clear any existing timeout
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    // Create a new promise that resolves after the debounce delay
    return new Promise<boolean>((resolve) => {
      this.debounceTimeout = setTimeout(() => {
        // When the timeout completes, check if this is still the most recent request
        const shouldDebounce = this.currentRequestId !== requestId;

        // If this is the most recent request, it shouldn't be debounced
        if (!shouldDebounce) {
          this.currentRequestId = undefined;
        }

        resolve(shouldDebounce);
      }, adaptiveDelay);
    });
  }
}
