package com.aika.companion.domain.live2d

enum class CompanionVisualState {
    IDLE,
    LISTENING,
    THINKING,
    SPEAKING,
    HAPPY,
    SHY,
    SAD,
}

interface Live2DController {
    fun setState(state: CompanionVisualState)
    fun setMouthLevel(level: Float)
    fun release()
}

