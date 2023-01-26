export async function addOrRemoveFavorite(marketAddress: any, favoriteMarkets: any[], setFavoriteMarkets: (arg0: any) => void) {
    // console.log('All favorite markets: ', favoriteMarkets)
    if (!Array.isArray(favoriteMarkets) || !favoriteMarkets.length) {
        favoriteMarkets = [];
    }

    const isFavorite = favoriteMarkets.filter((market: any) => market === marketAddress);

    if (isFavorite.length) {
        setFavoriteMarkets(favoriteMarkets.filter((fav: any) => fav !== marketAddress));
    } else {
        favoriteMarkets.push(marketAddress);
        setFavoriteMarkets(favoriteMarkets);
    }
}

export function isFavoriteMarkets(marketAddress: any, favoriteMarkets: any[]): Boolean {
    if (!Array.isArray(favoriteMarkets) || !favoriteMarkets.length) {
        return false;
    }
    return favoriteMarkets.find(favMarket => favMarket === marketAddress);
}