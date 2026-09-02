package com.aika.companion.domain

import com.aika.companion.data.ApiProtocol
import com.aika.companion.data.ApiProviderConfig
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

data class ProviderHttpRequest(
    val url: String,
    val headers: Map<String, String>,
    val body: String,
)

object ProviderPayloadCodec {
    fun buildRequest(
        provider: ApiProviderConfig,
        apiKey: String,
        instructions: String,
        input: String,
    ): ProviderHttpRequest {
        val headers = mutableMapOf("Content-Type" to "application/json")
        val body = when (provider.protocol) {
            ApiProtocol.OPENAI_RESPONSES -> {
                headers["Authorization"] = "Bearer $apiKey"
                OpenAiPayloadCodec.buildRequestBody(input, provider.model, instructions)
            }

            ApiProtocol.OPENAI_CHAT -> {
                headers["Authorization"] = "Bearer $apiKey"
                JSONObject()
                    .put("model", provider.model)
                    .put(
                        "messages",
                        JSONArray()
                            .put(JSONObject().put("role", "system").put("content", instructions))
                            .put(JSONObject().put("role", "user").put("content", input)),
                    )
            }

            ApiProtocol.ANTHROPIC_MESSAGES -> {
                headers["x-api-key"] = apiKey
                headers["anthropic-version"] = "2023-06-01"
                JSONObject()
                    .put("model", provider.model)
                    .put("max_tokens", 600)
                    .put("system", instructions)
                    .put(
                        "messages",
                        JSONArray().put(JSONObject().put("role", "user").put("content", input)),
                    )
            }

            ApiProtocol.GEMINI_GENERATE_CONTENT -> {
                headers["x-goog-api-key"] = apiKey
                JSONObject()
                    .put(
                        "systemInstruction",
                        JSONObject().put(
                            "parts",
                            JSONArray().put(JSONObject().put("text", instructions)),
                        ),
                    )
                    .put(
                        "contents",
                        JSONArray().put(
                            JSONObject()
                                .put("role", "user")
                                .put(
                                    "parts",
                                    JSONArray().put(JSONObject().put("text", input)),
                                ),
                        ),
                    )
                    .put(
                        "generationConfig",
                        JSONObject().put("responseMimeType", "application/json"),
                    )
            }
        }
        return ProviderHttpRequest(
            url = endpoint(provider),
            headers = headers,
            body = body.toString(),
        )
    }

    fun parseReply(protocol: ApiProtocol, responseBody: String): CompanionReply {
        val response = JSONObject(responseBody)
        val modelText = when (protocol) {
            ApiProtocol.OPENAI_RESPONSES -> extractResponsesText(response)
            ApiProtocol.OPENAI_CHAT -> extractOpenAiChatText(response)
            ApiProtocol.ANTHROPIC_MESSAGES -> extractTextParts(response.optJSONArray("content"))
            ApiProtocol.GEMINI_GENERATE_CONTENT -> {
                val parts = response.optJSONArray("candidates")
                    ?.optJSONObject(0)
                    ?.optJSONObject("content")
                    ?.optJSONArray("parts")
                extractTextParts(parts)
            }
        }
        return parseReplyJson(modelText)
    }

    fun endpoint(provider: ApiProviderConfig): String {
        val base = provider.baseUrl.trim().trimEnd('/')
        if (base.isBlank()) throw IOException("Base URL 不能为空")
        return when (provider.protocol) {
            ApiProtocol.OPENAI_RESPONSES -> appendUnlessPresent(base, "/responses")
            ApiProtocol.OPENAI_CHAT -> appendUnlessPresent(base, "/chat/completions")
            ApiProtocol.ANTHROPIC_MESSAGES -> appendAnthropicEndpoint(base)
            ApiProtocol.GEMINI_GENERATE_CONTENT -> {
                if (base.endsWith(":generateContent")) base
                else "$base/models/${provider.model}:generateContent"
            }
        }
    }

    private fun appendUnlessPresent(base: String, suffix: String): String =
        if (base.endsWith(suffix)) base else base + suffix

    private fun appendAnthropicEndpoint(base: String): String = when {
        base.endsWith("/v1/messages") -> base
        base.endsWith("/v1") -> "$base/messages"
        else -> "$base/v1/messages"
    }

    private fun extractResponsesText(response: JSONObject): String {
        response.optString("output_text").takeIf { it.isNotBlank() }?.let { return it }
        val output = response.optJSONArray("output") ?: JSONArray()
        for (outputIndex in 0 until output.length()) {
            val content = output.optJSONObject(outputIndex)?.optJSONArray("content") ?: continue
            val text = extractTextParts(content)
            if (text.isNotBlank()) return text
        }
        throw IOException("模型响应中没有文本")
    }

    private fun extractOpenAiChatText(response: JSONObject): String {
        val content = response.optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?.opt("content")
        return when (content) {
            is String -> content
            is JSONArray -> extractTextParts(content)
            else -> ""
        }.ifBlank { throw IOException("模型响应中没有文本") }
    }

    private fun extractTextParts(parts: JSONArray?): String {
        if (parts == null) return ""
        return buildString {
            for (index in 0 until parts.length()) {
                val item = parts.optJSONObject(index) ?: continue
                val text = item.optString("text")
                if (text.isNotBlank()) append(text)
            }
        }
    }

    private fun parseReplyJson(modelText: String): CompanionReply {
        val trimmed = modelText.trim()
            .removePrefix("```json")
            .removePrefix("```")
            .removeSuffix("```")
            .trim()
        val start = trimmed.indexOf('{')
        val end = trimmed.lastIndexOf('}')
        if (start < 0 || end <= start) throw IOException("模型没有返回要求的 JSON")
        val payload = JSONObject(trimmed.substring(start, end + 1))
        return CompanionReply(
            japaneseText = payload.getString("japanese_text").trim(),
            chineseTranslation = payload.getString("chinese_translation").trim(),
        )
    }
}
