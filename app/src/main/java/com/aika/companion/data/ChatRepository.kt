package com.aika.companion.data

import com.aika.companion.data.local.AikaDao
import com.aika.companion.data.local.ChatMessageEntity
import com.aika.companion.domain.CompanionEngine
import com.aika.companion.domain.CompanionContext
import com.aika.companion.domain.ConversationTurn
import com.aika.companion.domain.LanguageDetector
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow

@Singleton
class ChatRepository @Inject constructor(
    private val dao: AikaDao,
    private val engine: CompanionEngine,
) {
    val messages: Flow<List<ChatMessageEntity>> = dao.observeMessages()

    suspend fun send(text: String) {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) return

        val now = System.currentTimeMillis()
        dao.insertMessage(
            ChatMessageEntity(
                id = UUID.randomUUID().toString(),
                role = "user",
                source = "text",
                originalText = cleanText,
                originalLanguage = LanguageDetector.detect(cleanText),
                japaneseText = if (LanguageDetector.detect(cleanText) == "ja") cleanText else "",
                chineseTranslation = null,
                correctionOriginal = null,
                correctionNatural = null,
                correctionExplanationZh = null,
                createdAt = now,
            ),
        )

        val context = buildContext(excludeLatestMessage = true)
        val reply = engine.replyTo(cleanText, context)
        dao.insertMessage(
            companionMessage(
                japaneseText = reply.japaneseText,
                chineseTranslation = reply.chineseTranslation,
                source = "text",
                createdAt = now + 1,
            ),
        )
    }

    suspend fun createProactiveMessage(): ChatMessageEntity {
        val context = buildContext(excludeLatestMessage = false)
        val reply = engine.createProactiveMessage(context)
        return companionMessage(
            japaneseText = reply.japaneseText,
            chineseTranslation = reply.chineseTranslation,
            source = "proactive",
            createdAt = System.currentTimeMillis(),
        ).also { dao.insertMessage(it) }
    }

    suspend fun clear() = dao.clearMessages()

    private suspend fun buildContext(excludeLatestMessage: Boolean): CompanionContext {
        val messages = dao.recentMessages(20).asReversed().let {
            if (excludeLatestMessage && it.isNotEmpty()) it.dropLast(1) else it
        }
        return CompanionContext(
            recentTurns = messages.map { message ->
                ConversationTurn(
                    role = message.role,
                    text = if (message.role == "companion") message.japaneseText else message.originalText,
                )
            },
            memories = dao.recentMemories(12).map { it.content },
            totalMessageCount = dao.messageCount(),
            currentTimeInJapan = DateTimeFormatter.ofPattern("yyyy-MM-dd EEEE HH:mm")
                .withZone(ZoneId.of("Asia/Tokyo"))
                .format(Instant.now()),
        )
    }

    private fun companionMessage(
        japaneseText: String,
        chineseTranslation: String,
        source: String,
        createdAt: Long,
    ) = ChatMessageEntity(
        id = UUID.randomUUID().toString(),
        role = "companion",
        source = source,
        originalText = japaneseText,
        originalLanguage = "ja",
        japaneseText = japaneseText,
        chineseTranslation = chineseTranslation,
        correctionOriginal = null,
        correctionNatural = null,
        correctionExplanationZh = null,
        createdAt = createdAt,
    )
}
