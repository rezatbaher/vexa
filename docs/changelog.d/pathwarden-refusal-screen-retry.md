Google Meet refusal retries navigate to a fresh lobby before reading refusal indicators.
Cancellation and the original admission deadline are still checked before navigation.
The regression retains the old refusal screen until a new navigation, matching the
observed failed guest attempt instead of resetting the DOM between function calls.
