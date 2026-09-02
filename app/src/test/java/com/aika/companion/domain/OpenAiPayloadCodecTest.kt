package com.aika.companion.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenAiPayloadCodecTest {
    @Test
    fun requestUsesStrictStructuredOutputWithoutCloudStorage() {
        val body = OpenAiPayloadCodec.buildRequestBody(
            input = "こんにちは",
            model = "test-model",
            instructions = "test instructions",
        )

        assertEquals("test-model", body.getString("model"))
        assertFalse(body.getBoolean("store"))
        val format = body.getJSONObject("text").getJSONObject("format")
        assertEquals("json_schema", format.getString("type"))
        assertTrue(format.getBoolean("strict"))
    }

    @Test
    fun parsesTopLevelOutputText() {
        val response = """
            {
              "output_text": "{\"japanese_text\":\"今日はどうだった？\",\"chinese_translation\":\"今天过得怎么样？\"}"
            }
        """.trimIndent()

        val reply = OpenAiPayloadCodec.parseReply(response)

        assertEquals("今日はどうだった？", reply.japaneseText)
        assertEquals("今天过得怎么样？", reply.chineseTranslation)
    }

    @Test
    fun parsesNestedOutputTextWhenConvenienceFieldIsAbsent() {
        val response = """
            {
              "output": [{
                "type": "message",
                "content": [{
                  "type": "output_text",
                  "text": "{\"japanese_text\":\"会いたかったよ。\",\"chinese_translation\":\"我想你了。\"}"
                }]
              }]
            }
        """.trimIndent()

        val reply = OpenAiPayloadCodec.parseReply(response)

        assertEquals("会いたかったよ。", reply.japaneseText)
        assertEquals("我想你了。", reply.chineseTranslation)
    }
}

