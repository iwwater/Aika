package com.aika.companion.domain

object ProactivePolicy {
    const val MAX_DAILY_MESSAGES = 6
    const val MIN_INTERVAL_MS = 90L * 60L * 1000L

    fun isQuietHour(hour: Int, quietStartHour: Int, quietEndHour: Int): Boolean =
        if (quietStartHour < quietEndHour) {
            hour in quietStartHour until quietEndHour
        } else {
            hour >= quietStartHour || hour < quietEndHour
        }

    fun canSend(
        nowMillis: Long,
        hour: Int,
        quietStartHour: Int,
        quietEndHour: Int,
        messagesToday: Int,
        lastMessageAt: Long?,
    ): Boolean {
        if (isQuietHour(hour, quietStartHour, quietEndHour)) return false
        if (messagesToday >= MAX_DAILY_MESSAGES) return false
        if (lastMessageAt != null && nowMillis - lastMessageAt < MIN_INTERVAL_MS) return false
        return true
    }
}

