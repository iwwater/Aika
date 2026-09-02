package com.aika.companion.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.aika.companion.data.ApiProviderConfig
import com.aika.companion.data.AppSettings
import com.aika.companion.data.SecretStore
import com.aika.companion.data.SettingsRepository
import com.aika.companion.domain.MultiProviderCompanionEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val settingsRepository: SettingsRepository,
    private val secretStore: SecretStore,
    private val companionEngine: MultiProviderCompanionEngine,
) : ViewModel() {
    private val secretRevision = MutableStateFlow(0)

    val settings: StateFlow<AppSettings> = settingsRepository.settings.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = AppSettings(),
    )

    val providerState: StateFlow<ProviderUiState> = settingsRepository.settings
        .combine(secretRevision) { settings, _ ->
            ProviderUiState(
                providers = settings.providers,
                activeProviderId = settings.activeProviderId,
                providersWithKeys = settings.providers
                    .filter { secretStore.hasSecret(SecretStore.providerKeyName(it.id)) }
                    .mapTo(mutableSetOf()) { it.id },
            )
        }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = ProviderUiState(),
        )

    private val _connectionTest = MutableStateFlow(ConnectionTestState())
    val connectionTest: StateFlow<ConnectionTestState> = _connectionTest

    fun setProactiveEnabled(enabled: Boolean) {
        viewModelScope.launch { settingsRepository.setProactiveEnabled(enabled) }
    }

    fun saveProvider(provider: ApiProviderConfig, apiKey: String) {
        val id = provider.id.ifBlank { UUID.randomUUID().toString() }
        val cleanProvider = provider.copy(
            id = id,
            name = provider.name.trim(),
            baseUrl = provider.baseUrl.trim().trimEnd('/'),
            model = provider.model.trim(),
        )
        if (
            cleanProvider.name.isBlank() ||
            cleanProvider.baseUrl.isBlank() ||
            cleanProvider.model.isBlank()
        ) return

        viewModelScope.launch {
            settingsRepository.saveProvider(cleanProvider)
            if (apiKey.isNotBlank()) {
                secretStore.save(SecretStore.providerKeyName(id), apiKey.trim())
            }
            secretRevision.value += 1
        }
    }

    fun activateProvider(providerId: String) {
        viewModelScope.launch { settingsRepository.setActiveProvider(providerId) }
    }

    fun testProvider(providerId: String) {
        val provider = providerState.value.providers.firstOrNull { it.id == providerId } ?: return
        if (_connectionTest.value.testing) return
        viewModelScope.launch {
            _connectionTest.value = ConnectionTestState(
                providerId = providerId,
                testing = true,
                message = "正在连接 ${provider.name}…",
            )
            runCatching { companionEngine.testProvider(provider) }
                .onSuccess { reply ->
                    _connectionTest.value = ConnectionTestState(
                        providerId = providerId,
                        success = true,
                        message = "连接成功：${reply.japaneseText}",
                    )
                }
                .onFailure { error ->
                    _connectionTest.value = ConnectionTestState(
                        providerId = providerId,
                        success = false,
                        message = error.message ?: "连接失败，请检查 Base URL、模型和 API Key。",
                    )
                }
        }
    }

    fun dismissConnectionTest() {
        _connectionTest.value = ConnectionTestState()
    }

    fun deleteProvider(providerId: String) {
        viewModelScope.launch {
            settingsRepository.deleteProvider(providerId)
            secretStore.clear(SecretStore.providerKeyName(providerId))
            secretRevision.value += 1
        }
    }

    fun clearAllKeys() {
        providerState.value.providers.forEach { provider ->
            secretStore.clear(SecretStore.providerKeyName(provider.id))
        }
        secretRevision.value += 1
    }
}

data class ProviderUiState(
    val providers: List<ApiProviderConfig> = emptyList(),
    val activeProviderId: String? = null,
    val providersWithKeys: Set<String> = emptySet(),
) {
    val activeProvider: ApiProviderConfig?
        get() = providers.firstOrNull { it.id == activeProviderId }

    val activeProviderReady: Boolean
        get() = activeProviderId != null && activeProviderId in providersWithKeys
}

data class ConnectionTestState(
    val providerId: String? = null,
    val testing: Boolean = false,
    val success: Boolean? = null,
    val message: String? = null,
)
