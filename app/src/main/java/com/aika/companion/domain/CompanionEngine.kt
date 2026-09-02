package com.aika.companion.domain

data class CompanionReply(
    val japaneseText: String,
    val chineseTranslation: String,
)

data class ConversationTurn(
    val role: String,
    val text: String,
)

data class CompanionContext(
    val recentTurns: List<ConversationTurn>,
    val memories: List<String>,
    val totalMessageCount: Int,
    val currentTimeInJapan: String,
)

interface CompanionEngine {
    suspend fun replyTo(
        userText: String,
        context: CompanionContext,
    ): CompanionReply

    suspend fun createProactiveMessage(context: CompanionContext): CompanionReply
}
