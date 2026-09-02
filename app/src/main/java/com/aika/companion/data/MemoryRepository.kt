package com.aika.companion.data

import com.aika.companion.data.local.AikaDao
import com.aika.companion.data.local.MemoryEntity
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow

@Singleton
class MemoryRepository @Inject constructor(
    private val dao: AikaDao,
) {
    val memories: Flow<List<MemoryEntity>> = dao.observeMemories()

    suspend fun save(content: String, category: String = "日常") {
        val cleanContent = content.trim()
        if (cleanContent.isEmpty()) return
        val now = System.currentTimeMillis()
        dao.upsertMemory(
            MemoryEntity(
                id = UUID.randomUUID().toString(),
                category = category,
                content = cleanContent,
                createdAt = now,
                updatedAt = now,
            ),
        )
    }

    suspend fun delete(memory: MemoryEntity) = dao.deleteMemory(memory)
}

