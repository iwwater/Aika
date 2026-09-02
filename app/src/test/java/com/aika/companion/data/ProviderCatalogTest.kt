package com.aika.companion.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ProviderCatalogTest {
    @Test
    fun providerListRoundTripsThroughStorageJson() {
        val providers = listOf(
            ApiProviderConfig(
                id = "custom-1",
                name = "My Router",
                protocol = ApiProtocol.OPENAI_CHAT,
                baseUrl = "https://router.example/v1",
                model = "test-model",
            ),
        )

        assertEquals(providers, ProviderCatalog.decode(ProviderCatalog.encode(providers)))
    }

    @Test
    fun invalidStorageFallsBackToDefaults() {
        assertEquals(ProviderCatalog.defaults, ProviderCatalog.decode("not-json"))
    }
}
