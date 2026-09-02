package com.aika.companion.di

import android.content.Context
import androidx.room.Room
import com.aika.companion.data.local.AikaDao
import com.aika.companion.data.local.AikaDatabase
import com.aika.companion.domain.CompanionEngine
import com.aika.companion.domain.MultiProviderCompanionEngine
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class EngineModule {
    @Binds
    @Singleton
    abstract fun bindCompanionEngine(implementation: MultiProviderCompanionEngine): CompanionEngine
}

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AikaDatabase =
        Room.databaseBuilder(context, AikaDatabase::class.java, "aika.db").build()

    @Provides
    fun provideDao(database: AikaDatabase): AikaDao = database.aikaDao()
}
