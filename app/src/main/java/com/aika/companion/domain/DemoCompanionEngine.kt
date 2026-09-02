package com.aika.companion.domain

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.delay

/**
 * Offline placeholder used until an API key and a network provider are connected.
 * It deliberately identifies itself through the UI as demo mode.
 */
@Singleton
class DemoCompanionEngine @Inject constructor() : CompanionEngine {
    override suspend fun replyTo(
        userText: String,
        context: CompanionContext,
    ): CompanionReply {
        delay(650)
        val hasCjk = userText.any { it.code in 0x4E00..0x9FFF }
        return if (hasCjk) {
            CompanionReply(
                japaneseText = "うん、中国語で話しても大丈夫だよ。自然な日本語の言い方も一緒に考えよう。",
                chineseTranslation = "嗯，说中文也没关系。我们也可以一起想想自然的日语表达。",
            )
        } else {
            CompanionReply(
                japaneseText = "うん、ちゃんと聞いてるよ。もう少し話してくれる？",
                chineseTranslation = "嗯，我有在认真听。可以再多跟我说一点吗？",
            )
        }
    }

    override suspend fun createProactiveMessage(context: CompanionContext): CompanionReply =
        CompanionReply(
            japaneseText = "今、何してるの？ 少しだけ話したくなっちゃった。",
            chineseTranslation = "你现在在做什么？我突然有点想和你聊聊。",
        )
}
