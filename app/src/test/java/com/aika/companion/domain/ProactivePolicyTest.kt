package com.aika.companion.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProactivePolicyTest {
    @Test
    fun overnightQuietHoursIncludeLateNightAndEarlyMorning() {
        assertTrue(ProactivePolicy.isQuietHour(23, 23, 8))
        assertTrue(ProactivePolicy.isQuietHour(7, 23, 8))
        assertFalse(ProactivePolicy.isQuietHour(12, 23, 8))
    }

    @Test
    fun blocksWhenDailyLimitReached() {
        assertFalse(
            ProactivePolicy.canSend(
                nowMillis = 10_000_000,
                hour = 12,
                quietStartHour = 23,
                quietEndHour = 8,
                messagesToday = 6,
                lastMessageAt = null,
            ),
        )
    }

    @Test
    fun allowsMessageOutsideQuietHoursAfterCooldown() {
        assertTrue(
            ProactivePolicy.canSend(
                nowMillis = 10_000_000,
                hour = 12,
                quietStartHour = 23,
                quietEndHour = 8,
                messagesToday = 2,
                lastMessageAt = 1_000_000,
            ),
        )
    }
}

