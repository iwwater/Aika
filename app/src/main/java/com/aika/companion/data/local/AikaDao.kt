package com.aika.companion.data.local

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface AikaDao {
    @Query("SELECT * FROM chat_messages ORDER BY createdAt ASC")
    fun observeMessages(): Flow<List<ChatMessageEntity>>

    @Query("SELECT * FROM chat_messages ORDER BY createdAt DESC LIMIT :limit")
    suspend fun recentMessages(limit: Int): List<ChatMessageEntity>

    @Query("SELECT COUNT(*) FROM chat_messages")
    suspend fun messageCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessage(message: ChatMessageEntity)

    @Query("SELECT COUNT(*) FROM chat_messages WHERE source = 'proactive' AND createdAt >= :since")
    suspend fun proactiveCountSince(since: Long): Int

    @Query("SELECT MAX(createdAt) FROM chat_messages WHERE source = 'proactive'")
    suspend fun lastProactiveAt(): Long?

    @Query("DELETE FROM chat_messages")
    suspend fun clearMessages()

    @Query("SELECT * FROM memories ORDER BY updatedAt DESC")
    fun observeMemories(): Flow<List<MemoryEntity>>

    @Query("SELECT * FROM memories ORDER BY updatedAt DESC LIMIT :limit")
    suspend fun recentMemories(limit: Int): List<MemoryEntity>

    @Upsert
    suspend fun upsertMemory(memory: MemoryEntity)

    @Delete
    suspend fun deleteMemory(memory: MemoryEntity)
}
