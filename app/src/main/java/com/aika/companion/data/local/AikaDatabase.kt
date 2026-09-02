package com.aika.companion.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [ChatMessageEntity::class, MemoryEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class AikaDatabase : RoomDatabase() {
    abstract fun aikaDao(): AikaDao
}

