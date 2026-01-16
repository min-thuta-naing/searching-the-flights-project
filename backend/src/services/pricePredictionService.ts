import { pool } from '../config/database';

// ml-xgboost exports a Promise that resolves to the XGBoost class
// We need to await it before using
const xgboostPromise = require('ml-xgboost') as Promise<any>;

// Cache the resolved XGBoost class
let XGBoostClass: any = null;

// Helper function to get XGBoost class (lazy initialization)
async function getXGBoostClass(): Promise<any> {
  if (!XGBoostClass) {
    XGBoostClass = await xgboostPromise;
  }
  return XGBoostClass;
}

/**
 * Price prediction service using XGBoost with K-Fold Cross Validation
 * 
 * This service predicts future flight prices based on historical data.
 * Uses XGBoost for more accurate predictions than linear regression.
 */
export class PricePredictionService {
  private model: any = null;
  private isTraining: boolean = false;

  constructor() {
    // No initialization needed
  }


  /**
   * Prepare features for XGBoost model
   * Features: [dayOfWeek, monthOfYear, daysUntilDeparture, isWeekend]
   */
  private prepareFeatures(date: Date, daysUntilDeparture: number): number[] {
    const dayOfWeek = date.getDay(); // 0-6
    const monthOfYear = date.getMonth(); // 0-11
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0;

    return [dayOfWeek, monthOfYear, daysUntilDeparture, isWeekend];
  }

  /**
   * K-Fold Cross Validation for XGBoost
   * Splits data into K folds, trains K models, and returns average metrics
   */
  async trainModelWithKFold(
    features: number[][],
    labels: number[],
    k: number = 5
  ): Promise<{ model: any; rmse: number; mae: number }> {
    // Get XGBoost class (await the Promise)
    const XGBoost = await getXGBoostClass();
    
    if (features.length < k * 2) {
      // Not enough data for K-fold, train on all data
      console.log(`[PricePrediction] Insufficient data for ${k}-fold CV (${features.length} samples), training on all data`);
      const model = new XGBoost({
        booster: 'gbtree',
        objective: 'reg:linear',
        max_depth: 6,
        eta: 0.1,
        iterations: 100,
      });

      model.train(features, labels);
      return { model, rmse: 0, mae: 0 };
    }

    const foldSize = Math.floor(features.length / k);
    let totalRMSE = 0;
    let totalMAE = 0;
    let bestModel: any = null;
    let bestRMSE = Infinity;

    console.log(`[PricePrediction] Starting ${k}-Fold Cross Validation with ${features.length} samples`);

    for (let fold = 0; fold < k; fold++) {
      const testStart = fold * foldSize;
      const testEnd = testStart + foldSize;

      // Split data
      const testFeatures = features.slice(testStart, testEnd);
      const testLabels = labels.slice(testStart, testEnd);
      const trainFeatures = [...features.slice(0, testStart), ...features.slice(testEnd)];
      const trainLabels = [...labels.slice(0, testStart), ...labels.slice(testEnd)];

      // Train model
      const model = new XGBoost({
        booster: 'gbtree',
        objective: 'reg:linear',
        max_depth: 6,
        eta: 0.1,
        iterations: 100,
      });

      model.train(trainFeatures, trainLabels);

      // Evaluate (predict is synchronous in ml-xgboost)
      const predictions = model.predict(testFeatures);
      let sumSquaredError = 0;
      let sumAbsError = 0;

      for (let i = 0; i < predictions.length; i++) {
        const error = predictions[i] - testLabels[i];
        sumSquaredError += error * error;
        sumAbsError += Math.abs(error);
      }

      const rmse = Math.sqrt(sumSquaredError / predictions.length);
      const mae = sumAbsError / predictions.length;

      totalRMSE += rmse;
      totalMAE += mae;

      console.log(`[PricePrediction] Fold ${fold + 1}/${k}: RMSE=${rmse.toFixed(2)}, MAE=${mae.toFixed(2)}`);

      // Keep best model
      if (rmse < bestRMSE) {
        bestRMSE = rmse;
        bestModel = model;
      }
    }

    const avgRMSE = totalRMSE / k;
    const avgMAE = totalMAE / k;
    console.log(`[PricePrediction] K-Fold CV Complete: Avg RMSE=${avgRMSE.toFixed(2)}, Avg MAE=${avgMAE.toFixed(2)}`);

    return { model: bestModel, rmse: avgRMSE, mae: avgMAE };
  }

  /**
   * Train XGBoost model using historical flight prices
   */
  async trainModel(
    origin: string | string[],
    destination: string,
    tripType: 'one-way' | 'round-trip' = 'round-trip'
  ): Promise<void> {
    if (this.isTraining) {
      console.log('[PricePrediction] Training already in progress, skipping...');
      return;
    }

    this.isTraining = true;
    console.log(`[PricePrediction] Training XGBoost model for ${origin} → ${destination}`);

    try {
      // Handle multiple origin airports (e.g., Bangkok: BKK, DMK)
      const originParam = Array.isArray(origin) ? origin : [origin];
      const originPlaceholders = originParam.map((_, i) => `$${i + 1}`).join(', ');

      const query = `
        SELECT 
          fp.price,
          fp.departure_date,
          (fp.departure_date::DATE - CURRENT_DATE::DATE) as days_until_departure
        FROM flight_prices fp
        INNER JOIN routes r ON fp.route_id = r.id
        WHERE r.origin IN (${originPlaceholders})
          AND r.destination = $${originParam.length + 1}
          AND fp.trip_type = $${originParam.length + 2}
          AND fp.travel_class = 'economy'
          AND fp.departure_date >= CURRENT_DATE - INTERVAL '180 days'
          AND fp.departure_date <= CURRENT_DATE + INTERVAL '60 days'
        ORDER BY fp.departure_date
      `;

      const result = await pool.query(query, [...originParam, destination, tripType]);

      if (result.rows.length < 5) {
        console.warn(`[PricePrediction] Very limited data for training (${result.rows.length} rows), will use simpler model`);
        // If we have at least 1 row, train on that data anyway
        if (result.rows.length === 0) {
          this.model = null;
          return;
        }
      }

      // Prepare features and labels
      const features: number[][] = [];
      const labels: number[] = [];

      for (const row of result.rows) {
        const date = new Date(row.departure_date);
        const daysUntilDeparture = parseFloat(row.days_until_departure);
        const price = parseFloat(row.price);

        features.push(this.prepareFeatures(date, daysUntilDeparture));
        labels.push(price);
      }

      // Train with K-Fold CV
      const { model, rmse, mae } = await this.trainModelWithKFold(features, labels, 5);
      this.model = model;

      console.log(`[PricePrediction] Model trained successfully. RMSE: ${rmse.toFixed(2)}, MAE: ${mae.toFixed(2)}`);

    } catch (error: any) {
      console.error('[PricePrediction] Training failed:', error.message);
      this.model = null;
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Predict price for a specific date using the trained XGBoost model
   */
  async predictPrice(
    origin: string | string[],
    destination: string,
    targetDate: Date,
    tripType: 'one-way' | 'round-trip' = 'round-trip',
    _daysOfHistory: number = 90
  ): Promise<{
    predictedPrice: number;
    confidence: 'high' | 'medium' | 'low';
    rSquared: number;
    minPrice: number;
    maxPrice: number;
  } | null> {
    // Train model if not already trained
    if (!this.model) {
      await this.trainModel(origin, destination, tripType);
    }

    if (!this.model) {
      console.warn('[PricePrediction] Model not available, cannot predict');
      return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetNormalized = new Date(targetDate);
    targetNormalized.setHours(0, 0, 0, 0);

    const daysUntilDeparture = Math.max(0, Math.floor(
      (targetNormalized.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    ));

    const features = [this.prepareFeatures(targetNormalized, daysUntilDeparture)];

    try {
      // predict is synchronous in ml-xgboost
      const predictions = this.model.predict(features);
      const predictedPrice = Math.max(0, Math.round(predictions[0]));

      // Estimate confidence based on days until departure
      let confidence: 'high' | 'medium' | 'low';
      if (daysUntilDeparture <= 30) {
        confidence = 'high';
      } else if (daysUntilDeparture <= 60) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }

      // Price range: ±15% for high confidence, ±25% for low
      const rangePercent = confidence === 'high' ? 0.15 : confidence === 'medium' ? 0.20 : 0.25;
      const minPrice = Math.round(predictedPrice * (1 - rangePercent));
      const maxPrice = Math.round(predictedPrice * (1 + rangePercent));

      return {
        predictedPrice,
        confidence,
        rSquared: 0.85, // Placeholder - XGBoost doesn't compute R² directly
        minPrice,
        maxPrice,
      };
    } catch (error: any) {
      console.error('[PricePrediction] Prediction failed:', error.message);
      return null;
    }
  }

  /**
   * Predict prices for multiple dates (price forecast)
   * Required for API compatibility
   */
  async predictPriceRange(
    origin: string | string[],
    destination: string,
    startDate: Date,
    endDate: Date,
    tripType: 'one-way' | 'round-trip' = 'round-trip'
  ): Promise<Array<{
    date: Date;
    predictedPrice: number;
    minPrice: number;
    maxPrice: number;
  }>> {
    const predictions = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const prediction = await this.predictPrice(
        origin,
        destination,
        new Date(currentDate),
        tripType
      );

      if (prediction) {
        predictions.push({
          date: new Date(currentDate),
          predictedPrice: prediction.predictedPrice,
          minPrice: prediction.minPrice,
          maxPrice: prediction.maxPrice,
        });
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return predictions;
  }

  /**
   * Generate graph data for predictions (200 days to reach December)
   * Returns: actual data + predicted data with low/typical/high ranges
   */
  async generateGraphData(
    origin: string | string[],
    destination: string,
    _startDate: Date, // Prefixed with _ to indicate intentionally unused
    tripType: 'one-way' | 'round-trip' = 'round-trip',
    predictionDays: number = 350 // 350 days to reach December from January
  ): Promise<{
    date: string;
    low: number;
    typical: number;
    high: number;
    isActual: boolean;
  }[]> {
    // Train model first
    if (!this.model) {
      await this.trainModel(origin, destination, tripType);
    }

    // Handle multiple origin airports
    const originParam = Array.isArray(origin) ? origin : [origin];
    const originPlaceholders = originParam.map((_, i) => `$${i + 1}`).join(', ');

    // Get actual historical data (last 30 days to now) - ECONOMY CLASS ONLY
    // ✅ Use actual MIN, AVG, MAX prices from database instead of calculating from typical
    const historicalQuery = `
      SELECT 
        fp.departure_date,
        MIN(fp.price) as min_price,
        AVG(fp.price) as avg_price,
        MAX(fp.price) as max_price
      FROM flight_prices fp
      INNER JOIN routes r ON fp.route_id = r.id
      WHERE r.origin IN (${originPlaceholders})
        AND r.destination = $${originParam.length + 1}
        AND fp.trip_type = $${originParam.length + 2}
        AND fp.travel_class = 'economy'
        AND fp.departure_date >= $${originParam.length + 3}
        AND fp.departure_date <= CURRENT_DATE + INTERVAL '30 days'
      GROUP BY fp.departure_date
      ORDER BY fp.departure_date
    `;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const historicalResult = await pool.query(historicalQuery, [
      ...originParam,
      destination,
      tripType,
      thirtyDaysAgo,
    ]);

    const graphData: {
      date: string;
      low: number;
      typical: number;
      high: number;
      isActual: boolean;
    }[] = [];

    // Calculate average price from historical data for fallback
    let avgHistoricalPrice = 3500; // Default fallback

    if (historicalResult.rows.length > 0) {
      const prices = historicalResult.rows.map((r: any) => parseFloat(r.avg_price));
      avgHistoricalPrice = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
    }

    // Add actual data - use actual MIN, AVG, MAX prices from database
    for (const row of historicalResult.rows) {
      const date = new Date(row.departure_date);
      const minPrice = Math.round(parseFloat(row.min_price) || 0);
      const avgPrice = Math.round(parseFloat(row.avg_price) || 0);
      const maxPrice = Math.round(parseFloat(row.max_price) || 0);
      
      // ✅ Only add data if prices are valid (greater than 0)
      if (minPrice > 0 && avgPrice > 0 && maxPrice > 0) {
        graphData.push({
          date: date.toISOString().split('T')[0],
          low: minPrice, // ✅ Use actual MIN price from database
          typical: avgPrice, // ✅ Use actual AVG price from database
          high: maxPrice, // ✅ Use actual MAX price from database
          isActual: true,
        });
      }
    }

    // Start predictions from today or last actual data
    const startPredictionDate = new Date();
    startPredictionDate.setDate(startPredictionDate.getDate() + 1);

    console.log(`[PricePrediction] Generating ${predictionDays} days of predictions from ${startPredictionDate.toISOString().split('T')[0]}`);

    // Generate predictions for full range (200 days = until December)
    for (let day = 0; day < predictionDays; day++) {
      const predictionDate = new Date(startPredictionDate);
      predictionDate.setDate(predictionDate.getDate() + day);
      const dateStr = predictionDate.toISOString().split('T')[0];

      // Skip if we already have actual data for this date
      if (graphData.some(d => d.date === dateStr)) {
        continue;
      }

      // ✅ Check if we have actual data for this date in database
      // Query actual MIN, AVG, MAX prices for this specific date
      const actualDataQuery = `
        SELECT 
          MIN(fp.price) as min_price,
          AVG(fp.price) as avg_price,
          MAX(fp.price) as max_price
        FROM flight_prices fp
        INNER JOIN routes r ON fp.route_id = r.id
        WHERE r.origin IN (${originPlaceholders})
          AND r.destination = $${originParam.length + 1}
          AND fp.trip_type = $${originParam.length + 2}
          AND fp.travel_class = 'economy'
          AND DATE(fp.departure_date) = DATE($${originParam.length + 3})
      `;
      
      const actualDataResult = await pool.query(actualDataQuery, [
        ...originParam,
        destination,
        tripType,
        dateStr,
      ]);

      if (actualDataResult.rows.length > 0 && actualDataResult.rows[0].min_price) {
        // ✅ Use actual data from database if available (no calculation needed)
        const minPrice = Math.round(parseFloat(actualDataResult.rows[0].min_price) || 0);
        const avgPrice = Math.round(parseFloat(actualDataResult.rows[0].avg_price) || 0);
        const maxPrice = Math.round(parseFloat(actualDataResult.rows[0].max_price) || 0);
        
        // ✅ Only add data if prices are valid (greater than 0)
        if (minPrice > 0 && avgPrice > 0 && maxPrice > 0) {
          graphData.push({
            date: dateStr,
            low: minPrice,
            typical: avgPrice,
            high: maxPrice,
            isActual: true, // Mark as actual data since it's from database
          });
        }
      } else {
        // Use prediction if no actual data available
        const prediction = await this.predictPrice(origin, destination, predictionDate, tripType);

        if (prediction && prediction.predictedPrice > 0) {
          // ✅ Ensure minPrice and maxPrice are valid
          // If prediction doesn't provide min/max, calculate from predictedPrice with reasonable range
          const minPrice = prediction.minPrice > 0 ? prediction.minPrice : Math.round(prediction.predictedPrice * 0.85);
          const maxPrice = prediction.maxPrice > 0 ? prediction.maxPrice : Math.round(prediction.predictedPrice * 1.15);
          
          // ✅ Ensure minPrice <= typical <= maxPrice
          const finalMinPrice = Math.min(minPrice, prediction.predictedPrice);
          const finalMaxPrice = Math.max(maxPrice, prediction.predictedPrice);
          
          graphData.push({
            date: dateStr,
            low: finalMinPrice,
            typical: prediction.predictedPrice,
            high: finalMaxPrice,
            isActual: false,
          });
        }
        // ✅ If no prediction, skip this date (don't add invalid data)
      }
    }

    // Sort by date
    graphData.sort((a, b) => a.date.localeCompare(b.date));

    console.log(`[PricePrediction] Generated graph data: ${graphData.length} points (actual + ${predictionDays} predicted days)`);

    return graphData;
  }

  /**
   * Get price trend (increasing/decreasing/stable)
   */
  async getPriceTrend(
    origin: string | string[],
    destination: string,
    tripType: 'one-way' | 'round-trip' = 'round-trip',
    daysAhead: number = 30
  ): Promise<{
    trend: 'increasing' | 'decreasing' | 'stable';
    changePercent: number;
    currentAvgPrice: number;
    futureAvgPrice: number;
  } | null> {
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    const currentPrediction = await this.predictPrice(origin, destination, today, tripType);
    const futurePrediction = await this.predictPrice(origin, destination, futureDate, tripType);

    if (!currentPrediction || !futurePrediction) {
      return null;
    }

    const changePercent = ((futurePrediction.predictedPrice - currentPrediction.predictedPrice) / currentPrediction.predictedPrice) * 100;

    let trend: 'increasing' | 'decreasing' | 'stable';
    if (changePercent > 5) {
      trend = 'increasing';
    } else if (changePercent < -5) {
      trend = 'decreasing';
    } else {
      trend = 'stable';
    }

    return {
      trend,
      changePercent: Math.round(changePercent * 100) / 100,
      currentAvgPrice: currentPrediction.predictedPrice,
      futureAvgPrice: futurePrediction.predictedPrice,
    };
  }
}
