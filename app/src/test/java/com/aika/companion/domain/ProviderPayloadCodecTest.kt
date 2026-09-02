package com.aika.companion.domain

import com.aika.companion.data.ApiProtocol
import com.aika.companion.data.ApiProviderConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderPayloadCodecTest {
    @Test
    fun openAiCompatibleRequestUsesConfiguredBaseModelAndBearerKey() {
        val request = ProviderPayloadCodec.buildRequest(
            provider = provider(ApiProtocol.OPENAI_CHAT, "https://router.example/v1"),
            apiKey = "secret",
            instructions = "system",
            input = "hello",
        )

        assertEquals("https://router.example/v1/chat/completions", request.url)
        assertEquals("Bearer secret", request.headers["Authorization"])
        assertEquals("model-x", JSONObject(request.body).getString("model"))
    }

    @Test
    fun anthropicRequestUsesNativeEndpointAndHeaders() {
        val request = ProviderPayloadCodec.buildRequest(
            provider = provider(ApiProtocol.ANTHROPIC_MESSAGES, "https://api.anthropic.com"),
            apiKey = "secret",
            instructions = "system",
            input = "hello",
        )

        assertEquals("https://api.anthropic.com/v1/messages", request.url)
        assertEquals("secret", request.headers["x-api-key"])
        assertEquals("2023-06-01", request.headers["anthropic-version"])
    }

    @Test
    fun anthropicBaseEndingInV1DoesNotDuplicateVersionSegment() {
        val config = provider(ApiProtocol.ANTHROPIC_MESSAGES, "https://proxy.example/v1")

        assertEquals("https://proxy.example/v1/messages", ProviderPayloadCodec.endpoint(config))
    }

    @Test
    fun geminiRequestBuildsModelEndpoint() {
        val request = ProviderPayloadCodec.buildRequest(
            provider = provider(ApiProtocol.GEMINI_GENERATE_CONTENT, "https://example.test/v1beta"),
            apiKey = "secret",
            instructions = "system",
            input = "hello",
        )

        assertEquals(
            "https://example.test/v1beta/models/model-x:generateContent",
            request.url,
        )
        assertEquals("secret", request.headers["x-goog-api-key"])
        assertTrue(JSONObject(request.body).has("systemInstruction"))
    }

    @Test
    fun parsesFencedJsonFromOpenAiCompatibleResponse() {
        val response = """
            {"choices":[{"message":{"content":"```json\n{\"japanese_text\":\"おかえり\",\"chinese_translation\":\"欢迎回来\"}\n```"}}]}
        """.trimIndent()

        val reply = ProviderPayloadCodec.parseReply(ApiProtocol.OPENAI_CHAT, response)

        assertEquals("おかえり", reply.japaneseText)
        assertEquals("欢迎回来", reply.chineseTranslation)
    }

    @Test
    fun parsesAnthropicTextBlock() {
        val response = """
            {"content":[{"type":"text","text":"{\"japanese_text\":\"うん\",\"chinese_translation\":\"嗯\"}"}]}
        """.trimIndent()

        val reply = ProviderPayloadCodec.parseReply(ApiProtocol.ANTHROPIC_MESSAGES, response)

        assertEquals("うん", reply.japaneseText)
    }

    private fun provider(protocol: ApiProtocol, baseUrl: String) = ApiProviderConfig(
        id = "provider",
        name = "Provider",
        protocol = protocol,
        baseUrl = baseUrl,
        model = "model-x",
    )
}
