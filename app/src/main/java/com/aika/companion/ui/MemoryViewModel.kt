package com.aika.companion.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.aika.companion.data.MemoryRepository
import com.aika.companion.data.local.MemoryEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class MemoryViewModel @Inject constructor(
    private val repository: MemoryRepository,
) : ViewModel() {
    val memories: StateFlow<List<MemoryEntity>> = repository.memories.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = emptyList(),
    )

    fun add(content: String) {
        viewModelScope.launch { repository.save(content) }
    }

    fun delete(memory: MemoryEntity) {
        viewModelScope.launch { repository.delete(memory) }
    }
}

