package chrome

import (
	"math/rand"
	"time"
)

// randomDelay sleeps for a random duration between min and max milliseconds.
func randomDelay(minMs, maxMs int) {
	delay := rand.Intn(maxMs-minMs) + minMs
	time.Sleep(time.Duration(delay) * time.Millisecond)
}
