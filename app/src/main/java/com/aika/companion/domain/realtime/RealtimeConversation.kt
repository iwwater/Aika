package com.aika.companion.domain.realtime

import kotlinx.coroutines.flow.Flow

enum class RealtimeState {
    IDLE,
    CONNECTING,
    LISTENING,
    THINKING,
    SPEAKING,
    RECONNECTING,
    FAILED,
}

sealed interface RealtimeEvent {
    data class StateChanged(val state: RealtimeState) : RealtimeEvent
    data class UserTranscript(val text: String, val isFinal: Boolean) : RealtimeEvent
    data class CompanionTranscript(val text: String, val isFinal: Boolean) : RealtimeEvent
    data class AudioLevel(val value: Float) : RealtimeEvent
    data class Error(val message: String, val recoverable: Boolean) : RealtimeEvent
}

data class RealtimeSessionConfig(
    val instructions: String,
    val preferredProvider: String = "auto",
)

interface RealtimeConversation {
    val events: Flow<RealtimeEvent>

    suspend fun connect(config: RealtimeSessionConfig)
    suspend fun sendText(text: String)
    suspend fun setMicrophoneEnabled(enabled: Boolean)
    suspend fun interrupt()
    suspend fun disconnect()
}

