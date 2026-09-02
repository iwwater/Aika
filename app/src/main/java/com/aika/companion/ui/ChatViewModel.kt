package com.aika.companion.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.aika.companion.data.ChatRepository
import com.aika.companion.data.local.ChatMessageEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class ChatViewModel @Inject constructor(
    private val repository: ChatRepository,
) : ViewModel() {
    val messages: StateFlow<List<ChatMessageEntity>> = repository.messages.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = emptyList(),
    )

    private val _isSending = MutableStateFlow(false)
    val isSending: StateFlow<Boolean> = _isSending.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    fun send(text: String) {
        if (_isSending.value || text.isBlank()) return
        viewModelScope.launch {
            _isSending.value = true
            _errorMessage.value = null
            runCatching { repository.send(text) }
                .onFailure { error ->
                    _errorMessage.value = error.message ?: "连接模型失败，请检查供应商配置。"
                }
            _isSending.value = false
        }
    }

    fun dismissError() {
        _errorMessage.value = null
    }

    fun clear() {
        viewModelScope.launch { repository.clear() }
    }
}
