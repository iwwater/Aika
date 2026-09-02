package com.aika.companion.domain

import com.aika.companion.data.ApiProviderConfig
import com.aika.companion.data.SecretStore
import com.aika.companion.data.SettingsRepository
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Singleton
class MultiProviderCompanionEngine @Inject constructor(
    private val settingsRepository: SettingsRepository,
    private val secretStore: SecretStore,
    private val demoEngine: DemoCompanionEngine,
) : CompanionEngine {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(75, TimeUnit.SECONDS)
        .build()

    override suspend fun replyTo(userText: String, context: CompanionContext): CompanionReply {
        val active = activeProvider() ?: return demoEngine.replyTo(userText, context)
        val key = secretStore.read(SecretStore.providerKeyName(active.id))
            ?: return demoEngine.replyTo(userText, context)
        return requestReply(
            provider = active,
            apiKey = key,
            input = CompanionPromptBuilder.conversationInput(userText, context),
            instructions = CompanionPromptBuilder.instructions(context),
        )
    }

    override suspend fun createProactiveMessage(context: CompanionContext): CompanionReply {
        val active = activeProvider() ?: return demoEngine.createProactiveMessage(context)
        val key = secretStore.read(SecretStore.providerKeyName(active.id))
            ?: return demoEngine.createProactiveMessage(context)
        return requestReply(
            provider = active,
            apiKey = key,
            input = CompanionPromptBuilder.proactiveInput(context),
            instructions = CompanionPromptBuilder.instructions(context),
        )
    }

    suspend fun testProvider(provider: ApiProviderConfig): CompanionReply {
        val key = secretStore.read(SecretStore.providerKeyName(provider.id))
            ?: throw IOException("请先保存 ${provider.name} 的 API Key")
        val context = CompanionContext(
            recentTurns = emptyList(),
            memories = emptyList(),
            totalMessageCount = 0,
            currentTimeInJapan = DateTimeFormatter.ofPattern("yyyy-MM-dd EEEE HH:mm")
                .withZone(ZoneId.of("Asia/Tokyo"))
                .format(Instant.now()),
        )
        return requestReply(
            provider = provider,
            apiKey = key,
            input = "请只回复一句简短自然的日语问候，用于确认 API 连接正常。",
            instructions = CompanionPromptBuilder.instructions(context),
        )
    }

    private suspend fun activeProvider(): ApiProviderConfig? {
        val settings = settingsRepository.settings.first()
        return settings.providers.firstOrNull { it.id == settings.activeProviderId }
    }

    private suspend fun requestReply(
        provider: ApiProviderConfig,
        apiKey: String,
        input: String,
        instructions: String,
    ): CompanionReply = withContext(Dispatchers.IO) {
        val payload = ProviderPayloadCodec.buildRequest(provider, apiKey, instructions, input)
        val requestBuilder = Request.Builder()
            .url(payload.url)
            .post(payload.body.toRequestBody(JSON_MEDIA_TYPE))
        payload.headers.forEach { (name, value) -> requestBuilder.header(name, value) }

        client.newCall(requestBuilder.build()).execute().use { response ->
            val responseBody = response.body.string()
            if (!response.isSuccessful) {
                throw IOException("${provider.name} 连接失败（HTTP ${response.code}）")
            }
            ProviderPayloadCodec.parseReply(provider.protocol, responseBody)
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
