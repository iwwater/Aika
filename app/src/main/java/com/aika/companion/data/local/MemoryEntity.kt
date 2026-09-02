package com.aika.companion.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "memories")
data class MemoryEntity(
    @PrimaryKey val id: String,
    val category: String,
    val content: String,
    val createdAt: Long,
    val updatedAt: Long,
)

