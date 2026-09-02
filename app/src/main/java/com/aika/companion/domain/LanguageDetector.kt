package com.aika.companion.domain

object LanguageDetector {
    fun detect(text: String): String = when {
        text.any { it.code in 0x3040..0x30FF } -> "ja"
        text.any { it.code in 0x4E00..0x9FFF } -> "zh"
        else -> "mixed"
    }
}

