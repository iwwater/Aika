package com.aika.companion.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "chat_messages")
data class ChatMessageEntity(
    @PrimaryKey val id: String,
    val role: String,
    val source: String,
    val originalText: String,
    val originalLanguage: String,
    val japaneseText: String,
    val chineseTranslation: String?,
    val correctionOriginal: String?,
    val correctionNatural: String?,
    val correctionExplanationZh: String?,
    val createdAt: Long,
)

