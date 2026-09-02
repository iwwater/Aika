package com.aika.companion.data

import org.json.JSONArray
import org.json.JSONObject

enum class ApiProtocol(val displayName: String) {
    OPENAI_RESPONSES("OpenAI Responses"),
    OPENAI_CHAT("OpenAI 兼容 Chat"),
    ANTHROPIC_MESSAGES("Anthropic Messages"),
    GEMINI_GENERATE_CONTENT("Gemini generateContent"),
}

data class ApiProviderConfig(
    val id: String,
    val name: String,
    val protocol: ApiProtocol,
    val baseUrl: String,
    val model: String,
)

data class ProviderPreset(
    val name: String,
    val protocol: ApiProtocol,
    val baseUrl: String,
    val model: String,
)

object ProviderCatalog {
    val presets = listOf(
        ProviderPreset(
            name = "OpenAI",
            protocol = ApiProtocol.OPENAI_RESPONSES,
            baseUrl = "https://api.openai.com/v1",
            model = "gpt-5.6-luna",
        ),
        ProviderPreset(
            name = "千问（中国大陆）",
            protocol = ApiProtocol.OPENAI_CHAT,
            baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1",
            model = "qwen-plus",
        ),
        ProviderPreset(
            name = "Claude",
            protocol = ApiProtocol.ANTHROPIC_MESSAGES,
            baseUrl = "https://api.anthropic.com",
            model = "claude-sonnet-5",
        ),
        ProviderPreset(
            name = "Gemini",
            protocol = ApiProtocol.GEMINI_GENERATE_CONTENT,
            baseUrl = "https://generativelanguage.googleapis.com/v1beta",
            model = "gemini-3.7-flash",
        ),
        ProviderPreset(
            name = "自定义 OpenAI 兼容",
            protocol = ApiProtocol.OPENAI_CHAT,
            baseUrl = "https://",
            model = "",
        ),
    )

    val defaults = listOf(
        ApiProviderConfig(
            id = "openai",
            name = "OpenAI",
            protocol = ApiProtocol.OPENAI_RESPONSES,
            baseUrl = "https://api.openai.com/v1",
            model = "gpt-5.6-luna",
        ),
        ApiProviderConfig(
            id = "qwen",
            name = "千问",
            protocol = ApiProtocol.OPENAI_CHAT,
            baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1",
            model = "qwen-plus",
        ),
    )

    fun encode(providers: List<ApiProviderConfig>): String {
        val items = JSONArray()
        providers.forEach { provider ->
            items.put(
                JSONObject()
                    .put("id", provider.id)
                    .put("name", provider.name)
                    .put("protocol", provider.protocol.name)
                    .put("base_url", provider.baseUrl)
                    .put("model", provider.model),
            )
        }
        return items.toString()
    }

    fun decode(value: String?): List<ApiProviderConfig> {
        if (value.isNullOrBlank()) return defaults
        return runCatching {
            val items = JSONArray(value)
            buildList {
                for (index in 0 until items.length()) {
                    val item = items.getJSONObject(index)
                    add(
                        ApiProviderConfig(
                            id = item.getString("id"),
                            name = item.getString("name"),
                            protocol = ApiProtocol.valueOf(item.getString("protocol")),
                            baseUrl = item.getString("base_url"),
                            model = item.getString("model"),
                        ),
                    )
                }
            }
        }.getOrElse { defaults }
    }
}
