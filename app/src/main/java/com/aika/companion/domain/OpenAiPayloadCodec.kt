package com.aika.companion.domain

import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

object OpenAiPayloadCodec {
    fun buildRequestBody(
        input: String,
        model: String,
        instructions: String,
    ): JSONObject {
        val replySchema = JSONObject()
            .put("type", "object")
            .put("additionalProperties", false)
            .put(
                "properties",
                JSONObject()
                    .put("japanese_text", JSONObject().put("type", "string"))
                    .put("chinese_translation", JSONObject().put("type", "string")),
            )
            .put("required", JSONArray().put("japanese_text").put("chinese_translation"))

        val format = JSONObject()
            .put("type", "json_schema")
            .put("name", "aika_companion_reply")
            .put("strict", true)
            .put("schema", replySchema)

        return JSONObject()
            .put("model", model)
            .put("store", false)
            .put("instructions", instructions)
            .put("input", input)
            .put("text", JSONObject().put("format", format))
    }

    fun parseReply(responseBody: String): CompanionReply {
        val response = JSONObject(responseBody)
        val outputText = response.optString("output_text").ifBlank {
            val output = response.optJSONArray("output") ?: JSONArray()
            for (outputIndex in 0 until output.length()) {
                val content = output.optJSONObject(outputIndex)?.optJSONArray("content") ?: continue
                for (contentIndex in 0 until content.length()) {
                    val item = content.optJSONObject(contentIndex) ?: continue
                    if (item.optString("type") == "output_text") {
                        val text = item.optString("text")
                        if (text.isNotBlank()) return@ifBlank text
                    }
                }
            }
            ""
        }
        if (outputText.isBlank()) throw IOException("OpenAI response contained no output text")
        val payload = JSONObject(outputText)
        return CompanionReply(
            japaneseText = payload.getString("japanese_text").trim(),
            chineseTranslation = payload.getString("chinese_translation").trim(),
        )
    }
}

