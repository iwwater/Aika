package com.aika.companion.work

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.aika.companion.MainActivity
import com.aika.companion.R
import com.aika.companion.data.ChatRepository
import com.aika.companion.data.SettingsRepository
import com.aika.companion.data.local.AikaDao
import com.aika.companion.domain.ProactivePolicy
import com.aika.companion.notifications.NotificationChannels
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.flow.first

@HiltWorker
class ProactiveMessageWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted workerParams: WorkerParameters,
    private val repository: ChatRepository,
    private val settingsRepository: SettingsRepository,
    private val dao: AikaDao,
) : CoroutineWorker(appContext, workerParams) {
    override suspend fun doWork(): Result {
        val settings = settingsRepository.settings.first()
        if (!settings.proactiveEnabled) return Result.success()

        val zone = ZoneId.of("Asia/Tokyo")
        val now = Instant.now().atZone(zone)
        val hour = now.hour
        val dayStart = LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli()
        val messagesToday = dao.proactiveCountSince(dayStart)
        val lastMessageAt = dao.lastProactiveAt() ?: 0L
        if (
            !ProactivePolicy.canSend(
                nowMillis = System.currentTimeMillis(),
                hour = hour,
                quietStartHour = settings.quietStartHour,
                quietEndHour = settings.quietEndHour,
                messagesToday = messagesToday,
                lastMessageAt = lastMessageAt.takeIf { it > 0L },
            )
        ) return Result.success()

        val message = repository.createProactiveMessage()
        showNotification(message.japaneseText, message.chineseTranslation.orEmpty())
        return Result.success()
    }

    private fun showNotification(japanese: String, chinese: String) {
        if (
            android.os.Build.VERSION.SDK_INT >= 33 &&
            applicationContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return

        val intent = Intent(applicationContext, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            applicationContext,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(applicationContext, NotificationChannels.PROACTIVE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Aika")
            .setContentText(japanese)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$japanese\n$chinese"))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(applicationContext).notify(messageId(), notification)
    }

    private fun messageId(): Int = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
}
