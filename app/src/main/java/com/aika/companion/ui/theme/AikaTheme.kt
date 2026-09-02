package com.aika.companion.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AikaColors = lightColorScheme(
    primary = Color(0xFFD94F91),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFD8E8),
    onPrimaryContainer = Color(0xFF5A1234),
    secondary = Color(0xFF76546B),
    background = Color(0xFFFFF8FC),
    surface = Color(0xFFFFF8FC),
    surfaceVariant = Color(0xFFF7EAF1),
)

@Composable
fun AikaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AikaColors,
        content = content,
    )
}

