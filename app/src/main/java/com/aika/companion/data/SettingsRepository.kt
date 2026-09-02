package com.aika.companion.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.settingsDataStore by preferencesDataStore(name = "aika_settings")

data class AppSettings(
    val proactiveEnabled: Boolean = true,
    val quietStartHour: Int = 23,
    val quietEndHour: Int = 8,
    val providers: List<ApiProviderConfig> = ProviderCatalog.defaults,
    val activeProviderId: String? = ProviderCatalog.defaults.first().id,
)

@Singleton
class SettingsRepository @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {
    val settings: Flow<AppSettings> = context.settingsDataStore.data.map { preferences ->
        AppSettings(
            proactiveEnabled = preferences[PROACTIVE_ENABLED] ?: true,
            quietStartHour = preferences[QUIET_START] ?: 23,
            quietEndHour = preferences[QUIET_END] ?: 8,
            providers = ProviderCatalog.decode(preferences[PROVIDERS]),
            activeProviderId = preferences[ACTIVE_PROVIDER]
                ?: ProviderCatalog.defaults.first().id,
        )
    }

    suspend fun setProactiveEnabled(enabled: Boolean) {
        context.settingsDataStore.edit { it[PROACTIVE_ENABLED] = enabled }
    }

    suspend fun saveProvider(provider: ApiProviderConfig) {
        context.settingsDataStore.edit { preferences ->
            val providers = ProviderCatalog.decode(preferences[PROVIDERS]).toMutableList()
            val index = providers.indexOfFirst { it.id == provider.id }
            if (index >= 0) providers[index] = provider else providers.add(provider)
            preferences[PROVIDERS] = ProviderCatalog.encode(providers)
            if (preferences[ACTIVE_PROVIDER].isNullOrBlank()) {
                preferences[ACTIVE_PROVIDER] = provider.id
            }
        }
    }

    suspend fun deleteProvider(providerId: String) {
        context.settingsDataStore.edit { preferences ->
            val providers = ProviderCatalog.decode(preferences[PROVIDERS])
                .filterNot { it.id == providerId }
            preferences[PROVIDERS] = ProviderCatalog.encode(providers)
            if (preferences[ACTIVE_PROVIDER] == providerId) {
                val replacement = providers.firstOrNull()?.id
                if (replacement == null) preferences.remove(ACTIVE_PROVIDER)
                else preferences[ACTIVE_PROVIDER] = replacement
            }
        }
    }

    suspend fun setActiveProvider(providerId: String) {
        context.settingsDataStore.edit { it[ACTIVE_PROVIDER] = providerId }
    }

    private companion object {
        val PROACTIVE_ENABLED = booleanPreferencesKey("proactive_enabled")
        val QUIET_START = intPreferencesKey("quiet_start_hour")
        val QUIET_END = intPreferencesKey("quiet_end_hour")
        val PROVIDERS = stringPreferencesKey("api_providers")
        val ACTIVE_PROVIDER = stringPreferencesKey("active_api_provider")
    }
}
