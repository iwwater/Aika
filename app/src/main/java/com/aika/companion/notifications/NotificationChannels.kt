package com.aika.companion.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

object NotificationChannels {
    const val PROACTIVE = "proactive_messages"

    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                PROACTIVE,
                "Aika 主动消息",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Aika 想和你聊天时发送的本地通知"
            },
        )
    }
}
