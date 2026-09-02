package com.aika.companion.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class LanguageDetectorTest {
    @Test
    fun detectsJapaneseKana() {
        assertEquals("ja", LanguageDetector.detect("今日は何してるの？"))
    }

    @Test
    fun detectsChineseWithoutKana() {
        assertEquals("zh", LanguageDetector.detect("今天想和你聊天"))
    }

    @Test
    fun treatsLatinInputAsMixed() {
        assertEquals("mixed", LanguageDetector.detect("hello Aika"))
    }
}

