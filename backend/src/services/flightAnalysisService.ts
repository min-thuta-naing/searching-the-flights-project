import { FlightModel } from '../models/Flight';
import { PricePredictionService } from './pricePredictionService';
import { convertToAirportCode } from '../utils/airportCodeConverter';
import { logServiceError, logDatabaseError } from '../utils/errorLogger';
import {
  AnalyzeFlightPricesRequest,
  FlightAnalysisResult,
  SeasonData,
  PriceComparison,
} from '../types';
import { addDays, format, parseISO } from 'date-fns';
import { pool } from '../config/database';

const pricePredictionService = new PricePredictionService();


/**
 * Service for analyzing flight prices and generating recommendations
 * This service implements the business logic for flight price analysis
 * Uses database data only - no hardcoded values
 */
export class FlightAnalysisService {
  // Configuration: Number of days to compare before/after recommended date
  private static readonly PRICE_COMPARISON_DAYS = 7;

  // Travel class multipliers (relative to economy class)
  private static readonly TRAVEL_CLASS_MULTIPLIERS: Record<'economy' | 'business' | 'first', number> = {
    economy: 1.0,
    business: 2.5,  // Business class is typically 2.5x economy
    first: 4.0,      // First class is typically 4x economy
  };

  /**
   * Get travel class multiplier for price calculation
   */
  private getTravelClassMultiplier(travelClass: 'economy' | 'business' | 'first'): number {
    return FlightAnalysisService.TRAVEL_CLASS_MULTIPLIERS[travelClass] || 1.0;
  }

  public calculatePriceWithDiscounts(price: number, passengers: any): number {
    const adultPrice = price * passengers.adults;
    const childPrice = price * passengers.children * 0.75;
    const infantPrice = price * passengers.infants * 0.1;
    return adultPrice + childPrice + infantPrice;
  }

  /**
   * 
   * 
   * Analyze flight prices and generate recommendations
   * 
   * 
   */
  async analyzeFlightPrices(
    params: AnalyzeFlightPricesRequest
  ): Promise<FlightAnalysisResult> {
    const {
      origin,
      destination,
      durationRange,
      selectedAirlines,
      startDate,
      endDate,
      tripType,
      passengerCount,
      passengers = { adults: 1, children: 0, infants: 0 },
      travelClass = 'economy',
    } = params;

    // Debug: Log travel class parameter
    console.log('[FlightAnalysis] Travel class parameter:', {
      travelClass,
      receivedFromParams: params.travelClass,
      default: 'economy',
    });

    // Debug: Log passenger breakdown
    console.log('[FlightAnalysis] Passenger breakdown:', {
      passengerCount,
      passengers,
      adults: passengers.adults,
      children: passengers.children,
      infants: passengers.infants,
    });


    try {
      // Convert province/country values to airport codes
      let originAirportCode: string | string[] = await convertToAirportCode(origin);
      const destinationAirportCode = await convertToAirportCode(destination);

      // Handle Bangkok: query both BKK and DMK airports
      // Bangkok has 2 airports: BKK (Suvarnabhumi) and DMK (Don Mueang)
      if (originAirportCode === 'BKK' || origin.toLowerCase() === 'bangkok') {
        originAirportCode = ['BKK', 'DMK'];
        console.log(`[FlightAnalysis] Bangkok origin detected, querying both BKK and DMK`);
      }

      if (!originAirportCode || !destinationAirportCode) {
        throw new Error(
          `Failed to convert location to airport code: origin=${origin} (${originAirportCode}), destination=${destination} (${destinationAirportCode})`
        );
      }

      console.log(`[FlightAnalysis] Converting province values to airport codes:`, {
        origin: `${origin} -> ${originAirportCode}`,
        destination: `${destination} -> ${destinationAirportCode}`,
      });

      // Get available airlines for the route
      const availableAirlines = await FlightModel.getAvailableAirlines(
        originAirportCode,
        destinationAirportCode
      );

      // Filter airlines if selected
      let airlineIds: number[] | undefined;
      if (selectedAirlines.length > 0) {
        airlineIds = availableAirlines
          .filter((a) => selectedAirlines.includes(a.code))
          .map((a) => a.id);
      }

      // Parse dates - ใช้เฉพาะส่วนวันที่ (ไม่รวมเวลา) เพื่อหลีกเลี่ยง timezone issues
      // Frontend ส่งมาเป็น "2025-12-11" (date-only string)
      // Parse เป็น UTC date ที่เวลา 00:00:00 เพื่อให้แน่ใจว่าใช้วันที่ที่ถูกต้อง
      const startDateObj = startDate
        ? (() => {
          // ถ้าเป็น ISO string ให้เอาเฉพาะส่วนวันที่
          const dateOnly = startDate.split('T')[0]; // เช่น "2025-12-11"
          return parseISO(dateOnly + 'T00:00:00.000Z'); // สร้างเป็น UTC date
        })()
        : new Date();
      const endDateObj = endDate
        ? (() => {
          const dateOnly = endDate.split('T')[0];
          return parseISO(dateOnly + 'T00:00:00.000Z');
        })()
        : undefined;
      const avgDuration = (durationRange.min + durationRange.max) / 2;

      // For analysis, we need a wider date range to get data for all seasons
      // ⚡ CRITICAL: Always query MINIMUM 180 days (6 months) for accurate season calculation
      // Even if user selects a narrow date range (e.g. 15 days), we need full seasonal context
      const comparisonDays = FlightAnalysisService.PRICE_COMPARISON_DAYS;
      const MIN_DAYS_FOR_SEASON = 180; // Minimum 6 months for reliable season analysis

      // Calculate user's selected date range
      const userDateRange = endDateObj
        ? Math.abs((endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      // ✅ FORCE MINIMUM 180 DAYS: Expand range if user's selection is too narrow
      let analysisStartDate: Date;
      let analysisEndDate: Date;

      if (userDateRange < MIN_DAYS_FOR_SEASON) {
        // User selected narrow range (< 180 days) - expand to cover full year (12 months)
        console.log(`[FlightAnalysis] ⚠️  User range too narrow (${Math.floor(userDateRange)} days). Expanding to cover full year (12 months) for season calculation.`);

        // ✅ Fix: Expand to cover full year (12 months) instead of just 180 days
        const currentYear = startDateObj.getFullYear();
        const currentMonth = startDateObj.getMonth();

        // Start from 6 months before, end 6 months after (total 12 months)
        analysisStartDate = new Date(currentYear, currentMonth - 6, 1);
        analysisEndDate = new Date(currentYear, currentMonth + 6, 0); // Last day of month

        // Ensure we don't go too far in the past (limit to reasonable range)
        const minDate = new Date();
        minDate.setMonth(minDate.getMonth() - 12); // Don't go more than 12 months back
        if (analysisStartDate < minDate) {
          analysisStartDate = minDate;
        }
      } else {
        // User selected wide enough range - use their range with buffers
        analysisStartDate = addDays(startDateObj, -(comparisonDays + 7)); // Start 14 days before

        // ✅ Fix: Ensure we cover at least 12 months
        const endYear = endDateObj ? endDateObj.getFullYear() : startDateObj.getFullYear();
        const endMonth = endDateObj ? endDateObj.getMonth() : startDateObj.getMonth();
        const extendedEndDate = new Date(endYear, endMonth + 6, 0); // 6 months after end date

        // Use the later of: user's end date + 90 days OR 6 months after end date
        const userEndPlus90 = endDateObj ? addDays(endDateObj, 90) : addDays(startDateObj, 180 + comparisonDays);
        analysisEndDate = extendedEndDate > userEndPlus90 ? extendedEndDate : userEndPlus90;
      }

      // Log the expanded range for debugging
      console.log('[FlightAnalysis] 📅 Date range for season calculation:', {
        userSelected: endDateObj
          ? `${format(startDateObj, 'yyyy-MM-dd')} to ${format(endDateObj, 'yyyy-MM-dd')} (${Math.floor(userDateRange)} days)`
          : `${format(startDateObj, 'yyyy-MM-dd')} (single date)`,
        analysisRange: `${format(analysisStartDate, 'yyyy-MM-dd')} to ${format(analysisEndDate, 'yyyy-MM-dd')}`,
        analysisDays: Math.floor((analysisEndDate.getTime() - analysisStartDate.getTime()) / (1000 * 60 * 60 * 24)),
        expanded: userDateRange < MIN_DAYS_FOR_SEASON
      });

      // Get flight prices for analysis (wider date range for season calculation)
      // Query data directly from database based on selected travel class
      // Note: Season calculation will use the same travel class data
      let flightPrices;
      try {
        flightPrices = await FlightModel.getFlightPrices(
          originAirportCode,
          destinationAirportCode,
          analysisStartDate,
          analysisEndDate,
          tripType || 'round-trip',
          airlineIds,
          travelClass  // Query data for the selected travel class directly from database
        );
      } catch (dbError: any) {
        logDatabaseError('FlightAnalysisService.getFlightPrices', dbError, {
          origin: originAirportCode,
          destination: destinationAirportCode,
          startDate: analysisStartDate.toISOString(),
          endDate: analysisEndDate.toISOString(),
          tripType: tripType || 'round-trip',
          airlineIds,
        });
        // Ensure we throw an Error instance
        if (dbError instanceof Error) {
          throw dbError;
        }
        throw new Error(dbError?.message || dbError?.detail || JSON.stringify(dbError) || 'Database error');
      }

      // Log for debugging
      console.log(`[FlightAnalysis] Querying flights for ${originAirportCode} -> ${destinationAirportCode}:`, {
        originalParams: { origin, destination },
        airportCodes: { origin: originAirportCode, destination: destinationAirportCode },
        dateRange: `${format(analysisStartDate, 'yyyy-MM-dd')} to ${format(analysisEndDate, 'yyyy-MM-dd')}`,
        tripType: tripType || 'round-trip',
        airlineIds: airlineIds?.length || 'all',
        flightCount: flightPrices.length,
        travelClass: travelClass, // Query data for the selected travel class directly from database
      });

      // ✅ ใช้ราคาจาก DB โดยตรง (ไม่ต้องคูณ multiplier อีก)
      // เพราะราคาใน DB มี holiday multiplier รวมอยู่แล้ว (seed.ts บรรทัด 203)
      // ราคาใน DB = basePrice * seasonMultiplier * holidayMultiplier * priceVariation

      // Log flight prices breakdown by season for debugging
      // const seasonCounts = flightPrices.reduce((acc, fp) => {
      //   acc[fp.season] = (acc[fp.season] || 0) + 1;
      //   return acc;
      // }, {} as Record<string, number>);
      // console.log(`[FlightAnalysis] Flight prices by season:`, seasonCounts);
      const priceLevelCounts = flightPrices.reduce((acc, fp) => {
        const level = fp.price_level || 'unknown';
        acc[level] = (acc[level] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log(`[FlightAnalysis] Flight prices by price_level:`, priceLevelCounts);

      // Also check if we have valid price_level values
      const validPriceLevels = flightPrices.filter(fp => 
        fp.price_level && ['low', 'typical', 'high'].includes(fp.price_level)
      ).length;
      console.log(`[FlightAnalysis] Flights with valid price_level: ${validPriceLevels}/${flightPrices.length}`);




      // Calculate seasons using prices from DB (which already include multipliers)
      // ✅ Season calculation uses economy prices only (season is date-based, not class-based)
      // Travel class multiplier will be applied to season prices later
      const seasons = await this.calculateSeasons(
        originAirportCode,
        destinationAirportCode,
        flightPrices
      );

      // Log seasons data for debugging
      console.log(`[FlightAnalysis] Calculated seasons:`, seasons.map(s => ({
        type: s.type,
        months: s.months,
        monthsCount: s.months?.length || 0,
        priceRange: s.priceRange,
        bestDealPrice: s.bestDeal.price,
      })));

      // Find best deal (cheapest price across all seasons)
      const bestDeal = seasons.reduce((best, season) => {
        return season.bestDeal.price < best.bestDeal.price ? season : best;
      });

      // Always recommend best deal (system recommendation)
      // Try to find the actual flight from flightPrices that matches bestDeal price
      // Note: bestDeal.price already includes multiplier from DB
      const bestDealPrice = bestDeal.bestDeal.price;
      const bestDealSeason = bestDeal.type;
      const bestDealFlight = flightPrices.find(
        (fp) => fp.price === bestDealPrice && fp.season === bestDealSeason
      );

      let recommendedStartDate: Date; // System's recommended date (best deal)
      if (bestDealFlight && bestDealFlight.departure_date) {
        // Use the actual flight date from best deal
        recommendedStartDate = new Date(bestDealFlight.departure_date);
        console.log(`[FlightAnalysis] System recommendation: Using best deal date from flight: ${format(recommendedStartDate, 'yyyy-MM-dd')}`);
      } else {
        // Fallback: try to parse from bestDeal.dates string
        const bestDealDateStr = bestDeal.bestDeal.dates;
        if (bestDealDateStr) {
          // Parse best deal date (format: "DD เดือน YYYY" or "DD-DD เดือน YYYY")
          const dateMatch = bestDealDateStr.match(/(\d+)(?:\s*-\s*\d+)?\s+([ก-๙]+)\s+(\d+)/);
          if (dateMatch) {
            const day = parseInt(dateMatch[1]);
            const thaiMonth = dateMatch[2];
            const year = parseInt(dateMatch[3]);
            const monthIndex = this.getMonthIndexFromThaiName(thaiMonth);
            if (monthIndex !== -1) {
              recommendedStartDate = new Date(year, monthIndex, day);
              console.log(`[FlightAnalysis] System recommendation: Parsed best deal date from string: ${format(recommendedStartDate, 'yyyy-MM-dd')}`);
            } else {
              recommendedStartDate = startDateObj; // Fallback to today
              console.warn(`[FlightAnalysis] Could not parse month "${thaiMonth}" from bestDeal date. Using today.`);
            }
          } else {
            recommendedStartDate = startDateObj; // Fallback to today
            console.warn(`[FlightAnalysis] Could not parse bestDeal date string "${bestDealDateStr}". Using today.`);
          }
        } else {
          recommendedStartDate = startDateObj; // Fallback to today
          console.warn(`[FlightAnalysis] No bestDeal date available. Using today.`);
        }
      }

      // Store user's selected date if they provided one (for comparison)
      const userSelectedDate = startDate ? startDateObj : null;
      if (userSelectedDate) {
        console.log(`[FlightAnalysis] User selected date: ${format(userSelectedDate, 'yyyy-MM-dd')}, System recommends: ${format(recommendedStartDate, 'yyyy-MM-dd')}`);
      }

      // ✅ Calculate recommended end date based on duration range
      // คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange แล้วเลือกที่ถูกที่สุด
      let recommendedEndDate: Date;
      let recommendedDuration: number;
      if (tripType === 'round-trip') {
        const bestPriceResult = await this.getBestPriceForDateWithDurationRange(
          flightPrices,
          recommendedStartDate,
          durationRange,
          tripType || 'round-trip',
          travelClass
        );
        if (bestPriceResult.returnDate && bestPriceResult.duration) {
          recommendedEndDate = bestPriceResult.returnDate;
          recommendedDuration = bestPriceResult.duration;
          console.log(`[FlightAnalysis] Best duration for recommended date: ${recommendedDuration} days (from range ${durationRange.min}-${durationRange.max})`);
        } else {
          // Fallback: ใช้ค่าเฉลี่ยถ้าไม่เจอราคา
          recommendedEndDate = addDays(recommendedStartDate, Math.round(avgDuration));
          recommendedDuration = Math.round(avgDuration);
          console.warn(`[FlightAnalysis] No price found for duration range, using average: ${recommendedDuration} days`);
        }
      } else {
        // One-way: ไม่มีวันกลับ
        recommendedEndDate = recommendedStartDate;
        recommendedDuration = 0;
      }

      // ✅ System recommendation uses best price considering duration range
      // คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange แล้วเลือกที่ถูกที่สุด
      let recommendedPrice: number;
      if (tripType === 'round-trip') {
        const bestPriceResult = await this.getBestPriceForDateWithDurationRange(
          flightPrices,
          recommendedStartDate,
          durationRange,
          tripType || 'round-trip',
          travelClass
        );
        if (bestPriceResult.price > 0) {
          recommendedPrice = bestPriceResult.price;
          console.log(`[FlightAnalysis] Recommended price from duration range: ${recommendedPrice} (duration: ${bestPriceResult.duration} days)`);
        } else {
          // Fallback: ใช้ bestDeal.price ถ้าไม่เจอราคาจาก durationRange
          recommendedPrice = bestDeal.bestDeal.price;
          console.warn(`[FlightAnalysis] No price found for duration range, using bestDeal price: ${recommendedPrice}`);
        }
      } else {
        // One-way: ใช้ราคาไปเท่านั้น
        recommendedPrice = await this.getPriceForDate(
          flightPrices,
          recommendedStartDate,
          tripType || 'one-way',
          travelClass
        );
        if (recommendedPrice === 0) {
          // Fallback: ใช้ bestDeal.price ถ้าไม่เจอราคา
          recommendedPrice = bestDeal.bestDeal.price * 0.5; // One-way is half of round-trip
        }
      }

      // Find season for the recommended date (best deal season)
      const recommendedSeason = bestDeal;

      // ✅ Calculate season for user's selected date (if provided)
      // This ensures the season badge matches the selected date's month in the timeline
      const getSeasonForDate = (date: Date, seasons: SeasonData[]): 'high' | 'normal' | 'low' => {
        const month = date.getMonth() + 1; // Convert 0-11 to 1-12

        // Build monthSeasonMap from seasons data
        const monthSeasonMap: Record<number, 'high' | 'normal' | 'low'> = {};
        seasons.forEach(season => {
          season.months.forEach(monthName => {
            const monthIndex = this.getMonthIndexFromThaiName(monthName);
            if (monthIndex !== -1) {
              monthSeasonMap[monthIndex] = season.type;
            }
          });
        });

        return monthSeasonMap[month] || 'normal';
      };

      // ✅ Use season of selected date if available, otherwise use best deal season
      const selectedDateSeason = userSelectedDate
        ? getSeasonForDate(userSelectedDate, seasons)
        : recommendedSeason.type;

      // ✅ Calculate price comparison (before/after) based on USER SELECTED DATE if available
      // เพราะ "ถ้าคุณไปก่อน/หลัง" ควรหมายถึงการเปลี่ยนจากวันที่ที่เลือก
      const comparisonBaseDate = userSelectedDate || recommendedStartDate;
      const comparisonEndDate = userSelectedDate
        ? addDays(comparisonBaseDate, Math.round(avgDuration))
        : recommendedEndDate;

      // Generate chart data (use user's selected date if provided, otherwise recommended date)
      const chartStartDate = userSelectedDate || recommendedStartDate;

      // ✅ คำนวณ chartEndDate เพื่อให้กราฟแสดงแค่เดือนที่เลือก
      // ถ้ามี userSelectedDate ให้แสดงแค่เดือนของ userSelectedDate
      // ถ้าไม่มี ให้แสดงแค่เดือนของ recommendedStartDate
      const targetDateForChart = userSelectedDate || recommendedStartDate;
      const targetMonth = targetDateForChart.getMonth();
      const targetYear = targetDateForChart.getFullYear();
      const chartEndDate = new Date(targetYear, targetMonth + 1, 0); // วันสุดท้ายของเดือน

      // Generate chart data using prices from DB (which already include multipliers)
      const priceChartData = await this.generateChartData(
        flightPrices,
        chartStartDate,
        chartEndDate, // ✅ ใช้ chartEndDate เพื่อให้กราฟเลื่อนตามวันที่ที่เลือก
        durationRange, // ✅ ใช้ durationRange แทน avgDuration
        tripType || 'round-trip',
        // passengerCount
        passengers
      );

      // Note: recommendedPrice already includes multiplier from DB
      // (because DB prices = basePrice * seasonMultiplier * holidayMultiplier * priceVariation)
      const adjustedRecommendedPrice = this.calculatePriceWithDiscounts(recommendedPrice, passengers);      // const adultPrice = recommendedPrice * passengers.adults;
      // const childPrice = recommendedPrice * passengers.children * 0.75; // 25% discount for children
      // const infantPrice = recommendedPrice * passengers.infants * 0.1; // 90% discount for infants
      // const totalPrice = adultPrice + childPrice + infantPrice;
      // const adjustedRecommendedPrice = totalPrice;

      // Calculate price comparison using prices from DB
      const priceComparison = await this.calculatePriceComparison(
        flightPrices,
        comparisonBaseDate,  // ✅ ใช้ userSelectedDate ถ้ามี
        comparisonEndDate,
        durationRange, // ✅ ใช้ durationRange แทน avgDuration
        tripType || 'round-trip',
        // passengerCount,
        passengers,
        travelClass  // ✅ ส่ง travelClass เพื่อคูณราคา
      );


      // Calculate savings: compare user's selected date price (if any) vs best deal price
      // Savings represents how much the user saves by choosing the recommended date over their selected date
      let savings = 0;
      if (userSelectedDate) {
        // If user selected a date, calculate savings from that date to best deal
        // Use flightPrices from DB and apply travel class multiplier
        const userSelectedPrice = await this.getPriceForDate(
          flightPrices,
          userSelectedDate,
          tripType || 'round-trip',
          travelClass  // ✅ ส่ง travelClass เพื่อคูณราคา
        );

        // Only calculate savings if both prices are valid and user's price is higher
        if (userSelectedPrice > 0 && adjustedRecommendedPrice > 0 && userSelectedPrice > adjustedRecommendedPrice) {
          savings = userSelectedPrice - adjustedRecommendedPrice;
        }
        // If userSelectedPrice <= adjustedRecommendedPrice, savings = 0 (no savings, or user already chose best deal)

        console.log(`[FlightAnalysis] Savings calculation: User selected price ${userSelectedPrice} vs Best deal price ${adjustedRecommendedPrice} = Savings ${savings}`);
      } else {
        // If no date selected, calculate potential savings from high season to best deal
        // This shows how much the user could save by choosing the best deal over high season
        // Note: highSeasonPrice already includes multiplier from seasons calculation above
        const highSeason = seasons.find((s) => s.type === 'high');
        const highSeasonPrice = highSeason?.bestDeal.price || 0;

        // Only calculate savings if both prices are valid and high season price is higher
        // Note: adjustedRecommendedPrice already includes multiplier
        if (highSeasonPrice > 0 && adjustedRecommendedPrice > 0 && highSeasonPrice > adjustedRecommendedPrice) {
          savings = highSeasonPrice - adjustedRecommendedPrice;
        }
        // If best deal is already high season or prices are invalid, savings = 0

        console.log(`[FlightAnalysis] Savings calculation: High season price ${highSeasonPrice} vs Best deal price ${adjustedRecommendedPrice} = Savings ${savings}`);
      }

      // Get price prediction and trend (optional, won't fail if data is insufficient)
      let pricePrediction = undefined;
      let priceTrend = undefined;
      let priceGraphData: { date: string; low: number; typical: number; high: number; isActual: boolean }[] = [];

      try {
        if (startDateObj) {
          // Predict price for start date
          pricePrediction = await pricePredictionService.predictPrice(
            originAirportCode,
            destinationAirportCode,
            startDateObj,
            tripType || 'round-trip',
            90
          );

          // Get price trend
          priceTrend = await pricePredictionService.getPriceTrend(
            originAirportCode,
            destinationAirportCode,
            tripType || 'round-trip',
            30
          );

          // Generate 350-day price graph data using XGBoost (until December)
          priceGraphData = await pricePredictionService.generateGraphData(
            originAirportCode,
            destinationAirportCode,
            startDateObj,
            tripType || 'round-trip',
            350  // 350 days of predictions (until December)
          );
          console.log(`[FlightAnalysis] Generated price graph data: ${priceGraphData.length} points`);
        }
      } catch (error: any) {
        console.warn(`[FlightAnalysis] Price prediction failed: ${error.message}`);
        // Continue without prediction - it's optional
      }


      //debugging 
      console.log('FINAL PRICE CHECK', {
        base: recommendedPrice,
        passengers,
        final: adjustedRecommendedPrice
      });


      return {
        recommendedPeriod: {
          startDate: this.formatThaiDate(recommendedStartDate),
          endDate:
            tripType === 'one-way'
              ? ''
              : this.formatThaiDate(recommendedEndDate),
          returnDate:
            tripType === 'round-trip'
              ? this.formatThaiDate(recommendedEndDate)
              : '',
          // Apply one-way multiplier (0.5) to match seasons calculation
          // recommendedPrice comes from bestDeal.bestDeal.price which is round-trip price from database
          // Database already filtered by travel_class, so use price directly (no travel class multiplier)
          price: Math.round(
            adjustedRecommendedPrice *
            (tripType === 'one-way' ? 0.5 : 1) //*
            //passengerCount
          ),
          airline: this.getAirlineForDate(flightPrices, recommendedStartDate, tripType || 'round-trip') || bestDeal.bestDeal.airline,
          season: selectedDateSeason, // ✅ Use season of selected date, not best deal season
          savings: Math.round(
            savings *
            (tripType === 'one-way' ? 0.5 : 1) //*
            //passengerCount
          ),
        },
        // Note: seasons already have multipliers applied because DB prices include multipliers
        // Database already filtered by travel_class, so we just need to apply passengerCount and one-way multiplier
        seasons: (() => {
          return seasons.map((season) => {
            // Calculate price with passenger discounts for this season
            const adultPrice = season.bestDeal.price * passengers.adults;
            const childPrice = season.bestDeal.price * passengers.children * 0.75;
            const infantPrice = season.bestDeal.price * passengers.infants * 0.1;
            const totalPrice = adultPrice + childPrice + infantPrice;

            // Calculate price range with discounts
            const minPriceWithDiscount = (() => {
              const adultMin = season.priceRange.min * passengers.adults;
              const childMin = season.priceRange.min * passengers.children * 0.75;
              const infantMin = season.priceRange.min * passengers.infants * 0.1;
              return adultMin + childMin + infantMin;
            })();

            const maxPriceWithDiscount = (() => {
              const adultMax = season.priceRange.max * passengers.adults;
              const childMax = season.priceRange.max * passengers.children * 0.75;
              const infantMax = season.priceRange.max * passengers.infants * 0.1;
              return adultMax + childMax + infantMax;
            })();


            return {
              ...season,
              priceRange: {
                min: Math.round(
                  // season.priceRange.min *
                  minPriceWithDiscount *
                  (tripType === 'one-way' ? 0.5 : 1) //*
                  //passengerCount
                ),
                max: Math.round(
                  // season.priceRange.max *
                  maxPriceWithDiscount *
                  (tripType === 'one-way' ? 0.5 : 1) //*
                  //passengerCount
                ),
              },
              bestDeal: {
                ...season.bestDeal,
                price: Math.round(
                  // season.bestDeal.price *
                  totalPrice *
                  (tripType === 'one-way' ? 0.5 : 1) //*
                  //passengerCount
                ),
              },
            };
          });
        })(),
        priceComparison,
        priceChartData,
        pricePrediction: pricePrediction || undefined,
        priceTrend: priceTrend || undefined,
        // ✅ XGBoost 100-day price prediction graph data
        priceGraphData: priceGraphData || [],
        // ✅ ส่ง flightPrices จาก DB ไปยัง frontend (ใช้ราคาจาก database โดยตรง ไม่มี multiplier)
        // Note: DB prices = basePrice * seasonMultiplier * holidayMultiplier * priceVariation
        // Database already filtered by travel_class, so use price directly
        flightPrices: flightPrices.map((fp: any) => {
          // Convert carbon_emissions from grams to kg
          const carbonEmissionsKg = fp.carbon_emissions ? (fp.carbon_emissions / 1000).toFixed(1) : null;

          // ✅ Apply discount calculation to each flight price
          const adultPrice = fp.price * passengers.adults;
          const childPrice = fp.price * passengers.children * 0.75;
          const infantPrice = fp.price * passengers.infants * 0.1;
          const totalPrice = adultPrice + childPrice + infantPrice;

          return {
            id: fp.id,
            airline_id: fp.airline_id,
            airline_code: fp.airline_code || '',
            airline_name: fp.airline_name || '',
            airline_name_th: fp.airline_name_th || '',
            departure_date: fp.departure_date,
            return_date: fp.return_date,
            //price: Math.round(fp.price), // Use price directly from database (no travel class multiplier)
            price: Math.round(totalPrice),
            base_price: fp.base_price,
            departure_time: fp.departure_time,
            arrival_time: fp.arrival_time,
            duration: fp.duration,
            flight_number: fp.flight_number,
            trip_type: fp.trip_type,
            season: fp.season,
            travel_class: travelClass, // Include travel class in response
            airplane: fp.airplane || null,
            often_delayed: fp.often_delayed || false,
            carbon_emissions: carbonEmissionsKg,
            legroom: fp.legroom || null,
            origin: fp.origin || null, // Airport code for origin (e.g., BKK, DMK)
            destination: fp.destination || null, // Airport code for destination
          };
        }),
      };
    } catch (error: any) {
      // Variables may not be defined if error occurred early
      let originCode = 'unknown';
      let destCode = 'unknown';
      try {
        originCode = await convertToAirportCode(origin) || 'unknown';
        destCode = await convertToAirportCode(destination) || 'unknown';
      } catch {
        // Ignore errors in error logging
      }

      logServiceError('FlightAnalysisService', 'analyzeFlightPrices', error, {
        origin,
        destination,
        originAirportCode: originCode,
        destinationAirportCode: destCode,
        durationRange,
        startDate,
        endDate,
        tripType,
        passengerCount,
        selectedAirlines,
      });
      // Ensure we throw an Error instance
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(error?.message || error?.detail || JSON.stringify(error) || 'Flight analysis error');
    }
  }

//-----------------------------------------------------------------------------------------------------------------------------------
  /**
   * Calculate seasons based on flight prices
   * Calculates dynamically from actual price data only
   */
  private async calculateSeasons(
    origin: string | string[],
    destination: string,
    flightPrices: any[]
  ): Promise<SeasonData[]> {
    // Calculate from actual flight prices with pirce_level 
    console.log(`[FlightAnalysis] Calculating seasons from using price_level data for ${origin} → ${destination}`);
    return await this.calculateSeasonsWithDemand(origin, destination, flightPrices);
  }

   /**
   * Calculate seasons using price_level from flight data
   * No longer uses weather or holiday data - only price_level
   */
  private async calculateSeasonsWithDemand(
    origin: string,
    destination: string,
    flightPrices: any[]
  ): Promise<SeasonData[]> {
    // Get route ID (reserved for future use)
    const route = await FlightModel.getOrCreateRoute(origin, destination, 0, 0);

    // ✅ Calculate seasons using price_level from flight data
    // Weather and holiday data are no longer used
    return await this.calculateSeasonsFromFlightPricesWithDemand(
      flightPrices,
      route.id,
      new Map(), // Empty weather data map (deprecated)
      new Map(), // Empty holiday data map (deprecated)
      origin,
      destination
    );
  }

  /**
 * Calculate seasons using price_level column from flight data
 * Replaces the complex statistical calculation with direct use of database price_level
 */
private async calculateSeasonsFromFlightPricesWithDemand(
  flightPrices: any[],
  routeId: number,
  weatherDataMap: Map<string, number>,
  holidayDataMap: Map<string, number>,
  origin: string,
  destination: string
): Promise<SeasonData[]> {
  if (!flightPrices || flightPrices.length === 0) {
    // Return default empty seasons if no data
    return [
      {
        type: 'low',
        months: [],
        priceRange: { min: 0, max: 0 },
        bestDeal: { dates: '', price: 0, airline: '' },
        description: 'No data available',
      },
      {
        type: 'normal',
        months: [],
        priceRange: { min: 0, max: 0 },
        bestDeal: { dates: '', price: 0, airline: '' },
        description: 'No data available',
      },
      {
        type: 'high',
        months: [],
        priceRange: { min: 0, max: 0 },
        bestDeal: { dates: '', price: 0, airline: '' },
        description: 'No data available',
      },
    ];
  }

  // Log for debugging
  console.log(`[FlightAnalysis] Using price_level for season calculation`);
  console.log(`[FlightAnalysis] Sample flight price_level:`, {
    hasPriceLevel: flightPrices[0]?.price_level !== undefined,
    priceLevel: flightPrices[0]?.price_level,
    totalFlights: flightPrices.length,
  });

  console.log('NNNnnnnnnnnnnnnnn[FlightAnalysis] Checking flight price object structure:', {
    hasPriceLevel: flightPrices[0]?.price_level !== undefined,
    priceLevelSample: flightPrices[0]?.price_level,
    sampleFlight: flightPrices[0]
  });

  // Group flights by price_level
  const lowFlights = flightPrices.filter(fp => fp.price_level === 'low');
  const typicalFlights = flightPrices.filter(fp => fp.price_level === 'typical');
  const highFlights = flightPrices.filter(fp => fp.price_level === 'high');

  // If no flights have price_level, fallback to old method
  const flightsWithPriceLevel = flightPrices.filter(fp => 
    fp.price_level && ['low', 'typical', 'high'].includes(fp.price_level)
  );

  if (flightsWithPriceLevel.length === 0) {
    console.warn('[FlightAnalysis] No valid flights have price_level, falling back to old method');
    return this._calculateSeasonsFromFlightPrices_DEPRECATED(flightPrices);
  }

  // Get unique months for each price_level
  const getMonthsForFlights = (flights: any[]): number[] => {
    const monthSet = new Set<number>();
    flights.forEach(fp => {
      if (fp.departure_date) {
        const date = new Date(fp.departure_date);
        // Use UTC to avoid timezone issues
        const month = date.getUTCMonth() + 1; // Convert 0-11 to 1-12
        monthSet.add(month);
      }
    });
    return Array.from(monthSet).sort((a, b) => a - b);
  };

  // Get price range for flights
  const getPriceRangeForFlights = (flights: any[]): { min: number; max: number } => {
    if (flights.length === 0) {
      return { min: 0, max: 0 };
    }
    const prices = flights.map(fp => fp.price).filter(price => !isNaN(price) && price > 0);
    if (prices.length === 0) {
      return { min: 0, max: 0 };
    }
    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
    };
  };

  // Find best deal for flights
  const findBestDealForFlights = (flights: any[]): { dates: string; price: number; airline: string } => {
    if (flights.length === 0) {
      return { dates: '', price: 0, airline: '' };
    }

    // Find cheapest flight
    const cheapestFlight = flights.reduce((best, current) => {
      if (!best || current.price < best.price) {
        return current;
      }
      return best;
    });

    if (!cheapestFlight) {
      return { dates: '', price: 0, airline: '' };
    }

    // Format date
    let dateStr = '';
    if (cheapestFlight.departure_date) {
      const date = new Date(cheapestFlight.departure_date);
      dateStr = this.formatThaiDate(date);
    }

    // Get airline name
    const airlineName = cheapestFlight.airline_name_th || 
                       cheapestFlight.airline_name || 
                       cheapestFlight.airline_code || 
                       '';

    return {
      dates: dateStr,
      price: cheapestFlight.price,
      airline: airlineName,
    };
  };

  // Helper function to get Thai month name
  const getThaiMonthName = (month: number): string => {
    const thaiMonths = [
      'มกราคม',
      'กุมภาพันธ์',
      'มีนาคม',
      'เมษายน',
      'พฤษภาคม',
      'มิถุนายน',
      'กรกฎาคม',
      'สิงหาคม',
      'กันยายน',
      'ตุลาคม',
      'พฤศจิกายน',
      'ธันวาคม',
    ];
    return thaiMonths[month - 1] || ''; // month is 1-12
    };

    // Build seasons data
    const seasons: SeasonData[] = [
      {
        type: 'low',
        months: getMonthsForFlights(lowFlights).map(m => getThaiMonthName(m)),
        priceRange: getPriceRangeForFlights(lowFlights),
        bestDeal: findBestDealForFlights(lowFlights),
        description: 'ราคาถูกที่สุดของปี เหมาะสำหรับผู้ที่มีความยืดหยุ่นในการเดินทาง',
      },
      {
        type: 'normal',
        months: getMonthsForFlights(typicalFlights).map(m => getThaiMonthName(m)),
        priceRange: getPriceRangeForFlights(typicalFlights),
        bestDeal: findBestDealForFlights(typicalFlights),
        description: 'ราคาปานกลาง อากาศดี เหมาะสำหรับการท่องเที่ยว',
      },
      {
        type: 'high',
        months: getMonthsForFlights(highFlights).map(m => getThaiMonthName(m)),
        priceRange: getPriceRangeForFlights(highFlights),
        bestDeal: findBestDealForFlights(highFlights),
        description: 'ช่วงเทศกาลและปิดเทอม ราคาสูงสุด แนะนำจองล่วงหน้า',
      },
    ];

    // Log for debugging
    console.log(`[FlightAnalysis] Season calculation from price_level:`, {
      low: {
        months: seasons[0].months,
        flightCount: lowFlights.length,
        priceRange: seasons[0].priceRange,
      },
      normal: {
        months: seasons[1].months,
        flightCount: typicalFlights.length,
        priceRange: seasons[1].priceRange,
      },
      high: {
        months: seasons[2].months,
        flightCount: highFlights.length,
        priceRange: seasons[2].priceRange,
      },
    });

    return seasons;
  }

//-----------------------------------------------------------------------------------------------------------------------------------

  /**
   * Get best price for a specific departure date considering duration range
   * ✅ คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange แล้วเลือกที่ถูกที่สุด
   * สำหรับ round-trip: คำนวณราคาไป + กลับสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange
   * สำหรับ one-way: ใช้ราคาไปเท่านั้น
   */
  private async getBestPriceForDateWithDurationRange(
    flightPrices: any[],
    departureDate: Date,
    durationRange: { min: number; max: number },
    tripType: 'one-way' | 'round-trip',
    travelClass: 'economy' | 'business' | 'first' = 'economy'
  ): Promise<{ price: number; returnDate: Date | null; duration: number | null }> {
    if (!flightPrices || flightPrices.length === 0) {
      return { price: 0, returnDate: null, duration: null };
    }

    // สำหรับ one-way: ใช้ราคาไปเท่านั้น
    if (tripType === 'one-way') {
      const oneWayPrice = await this.getPriceForDate(
        flightPrices,
        departureDate,
        tripType,
        travelClass
      );
      return { price: oneWayPrice, returnDate: null, duration: null };
    }

    // สำหรับ round-trip: คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange
    let bestPrice = Infinity;
    let bestReturnDate: Date | null = null;
    let bestDuration: number | null = null;

    // Loop ผ่านทุกค่าที่เป็นไปได้ในช่วง durationRange
    for (let duration = durationRange.min; duration <= durationRange.max; duration++) {
      const returnDate = addDays(departureDate, duration);
      
      // หาราคาไป (departure)
      const departurePrice = await this.getPriceForDate(
        flightPrices,
        departureDate,
        'one-way',
        travelClass
      );

      // หาราคากลับ (return)
      const returnPrice = await this.getPriceForDate(
        flightPrices,
        returnDate,
        'one-way',
        travelClass
      );

      // ถ้ามีราคาทั้งไปและกลับ ให้คำนวณราคารวม
      if (departurePrice > 0 && returnPrice > 0) {
        const totalPrice = departurePrice + returnPrice;
        
        // ถ้าราคารวมถูกกว่าที่เคยเจอ ให้อัพเดท
        if (totalPrice < bestPrice) {
          bestPrice = totalPrice;
          bestReturnDate = returnDate;
          bestDuration = duration;
        }
      }
    }

    // ถ้าไม่เจอราคาที่ถูกต้อง ให้ return 0
    if (bestPrice === Infinity) {
      return { price: 0, returnDate: null, duration: null };
    }

    return { price: bestPrice, returnDate: bestReturnDate, duration: bestDuration };
  }

//-----------------------------------------------------------------------------------------------------------------------------------

  /**
   * Get price for a specific date
   * ✅ แก้ไข: ใช้ราคาจริงของเที่ยวบินที่ถูกที่สุดในวันที่เลือกเท่านั้น (เหมือนเว็บสายการบินจริงๆ)
   * ไม่ใช้ราคาเฉลี่ยเป็น fallback
   * Note: flightPrices from DB already include multipliers (holiday multiplier is in DB)
   */
  private async getPriceForDate(
    flightPrices: any[],
    date: Date,
    tripType: 'one-way' | 'round-trip',
    travelClass: 'economy' | 'business' | 'first' = 'economy'
  ): Promise<number> {
    if (!flightPrices || flightPrices.length === 0) {
      return 0;
    }

    // ✅ ใช้ UTC methods เพื่อหลีกเลี่ยง timezone issues
    // เพราะ date ที่ส่งมาเป็น UTC date (T00:00:00.000Z)
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const matchingFlights = flightPrices.filter(
      (fp) => {
        // ✅ ใช้ UTC methods สำหรับ departure_date ด้วย
        const fpDate = fp.departure_date instanceof Date
          ? fp.departure_date
          : new Date(fp.departure_date);
        const fpYear = fpDate.getUTCFullYear();
        const fpMonth = String(fpDate.getUTCMonth() + 1).padStart(2, '0');
        const fpDay = String(fpDate.getUTCDate()).padStart(2, '0');
        const fpDateStr = `${fpYear}-${fpMonth}-${fpDay}`;

        return fpDateStr === dateStr && fp.trip_type === tripType;
      }
    );

    // ✅ ถ้าไม่มีเที่ยวบินตรงวันที่เลือก → return 0 (ไม่ใช้ราคาเฉลี่ย)
    // เหมือนเว็บสายการบินจริงๆ ที่แสดง "ไม่มีข้อมูล" ถ้าไม่มีเที่ยวบินในวันนั้น
    if (matchingFlights.length === 0) {
      return 0;
    }

    // หาราคาที่ถูกที่สุดในวันนั้น
    const cheapest = matchingFlights.reduce((best, current) =>
      current.price < best.price ? current : best
    );

    // Ensure price is a valid number
    const price = cheapest?.price;
    if (price == null || isNaN(price)) {
      return 0;
    }

    // Use price directly from database (no travel class multiplier)
    // Database already filtered by travel_class, so use price directly
    const finalPrice = price;

    if (Math.random() < 0.1) { // Log 10% of calls
      console.log('[FlightAnalysis.getPriceForDate] Final price:', {
        originalPrice: price,
        finalPrice,
        travelClass,
        dbTravelClass: cheapest?.travel_class || 'economy',
      });
    }

    return finalPrice;
  }

  //-----------------------------------------------------------------------------------------------------------------------------------


    /**
   * Generate chart data for price visualization
   * ✅ แก้ไข: เป็น async function เพื่อรองรับ await ใน getBestPriceForDateWithDurationRange
   */
  private async generateChartData(
    flightPrices: any[],
    startDate?: Date,
    endDate?: Date,
    durationRange?: { min: number; max: number }, // ✅ เปลี่ยนจาก avgDuration เป็น durationRange
    tripType?: 'one-way' | 'round-trip',
    _passengers?: any // Prefixed with _ to indicate intentionally unused
    // passengerCount: number = 1,
  ): Promise<Array<{
    startDate: string;
    returnDate: string;
    price: number;
    season: 'high' | 'normal' | 'low';
    duration?: number;
  }>> {
    const data: Array<{
      startDate: string;
      returnDate: string;
      price: number;
      season: 'high' | 'normal' | 'low';
      duration?: number;
    }> = [];

    // ✅ ใช้ endDate เป็นจุดสิ้นสุด (หรือ startDate ถ้าไม่มี endDate)
    // แต่ถ้า startDate อยู่นอกช่วงข้อมูล ให้ใช้ startDate เป็นจุดสิ้นสุดของกราฟ
    const endPointDate = endDate || startDate || new Date();

    // ✅ หาช่วงวันที่ที่มีข้อมูลจริงๆ จาก flightPrices ก่อน
    // Note: Currently not used, but kept for future reference
    // let dataStartDate: Date | null = null;
    // let dataEndDate: Date | null = null;

    // if (flightPrices.length > 0) {
    //   const dates = flightPrices
    //     .map((fp) => {
    //       const date = fp.departure_date instanceof Date 
    //         ? fp.departure_date 
    //         : new Date(fp.departure_date);
    //       return date;
    //     })
    //     .sort((a, b) => a.getTime() - b.getTime());
    //   
    //   dataStartDate = dates[0];
    //   dataEndDate = dates[dates.length - 1];
    // }

    // ✅ ปรับให้กราฟแสดงแค่เดือนที่เลือก และเลื่อนตามวันที่ที่เลือก:
    // - ใช้ startDate เป็นเดือนที่จะแสดง (ถ้าไม่มี startDate ให้ใช้ endDate หรือวันนี้)
    // - แสดงแค่เดือนเดียว: เริ่มจากวันที่ 1 ของเดือน และจบที่วันสุดท้ายของเดือน
    const targetDate = startDate || endPointDate;
    const targetMonth = targetDate.getUTCMonth(); // ✅ ใช้ UTC เพื่อหลีกเลี่ยงปัญหา timezone
    const targetYear = targetDate.getUTCFullYear(); // ✅ ใช้ UTC

    // ✅ แสดงแค่เดือนที่เลือก: เริ่มจากวันที่ 1 และจบที่วันสุดท้ายของเดือน
    // ✅ ใช้ UTC Date เพื่อหลีกเลี่ยงปัญหา timezone
    const chartStartDate = new Date(Date.UTC(targetYear, targetMonth, 1));
    const chartEndDate = new Date(Date.UTC(targetYear, targetMonth + 1, 0)); // วันสุดท้ายของเดือน

    let currentDate = new Date(chartStartDate);
    while (currentDate <= chartEndDate) {
      // Use price from flightPrices array (which should have multiplier applied)
      // ✅ ปรับให้ match วันที่ได้ถูกต้อง โดยใช้ UTC date string เพื่อให้ตรงกับข้อมูลจาก database
      // ข้อมูลจาก database เป็น DATE ซึ่งเมื่อ query มาเป็น timestamp จะเป็น UTC
      // ดังนั้นต้องใช้ UTC date string เพื่อ match กัน
      const currentDateStr = currentDate.toISOString().split('T')[0];

      const matchingFlight = flightPrices.find(
        (fp) => {
          const fpDate = fp.departure_date instanceof Date
            ? fp.departure_date
            : new Date(fp.departure_date);
          // ✅ ใช้ UTC date string เพื่อให้ตรงกับข้อมูลจาก database
          const fpDateStr = fpDate.toISOString().split('T')[0];
          return fpDateStr === currentDateStr;
        }
      );
      // Note: price from matchingFlight should already have multiplier applied
      // since we apply it in the flightPrices array before calling generateChartData
      const price = matchingFlight ? matchingFlight.price : 0;

      const flight = flightPrices.find(
        (fp) => {
          const fpDate = fp.departure_date instanceof Date
            ? fp.departure_date
            : new Date(fp.departure_date);
          // ✅ ใช้ UTC date string เพื่อให้ตรงกับข้อมูลจาก database
          const fpDateStr = fpDate.toISOString().split('T')[0];
          return fpDateStr === currentDateStr;
        }
      );

      // ✅ สำหรับ round-trip: คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange แล้วเลือกที่ถูกที่สุด
      let returnDate: Date | null = null;
      let bestPrice = 0;
      let bestDuration: number | undefined = undefined;
      
      if (tripType === 'round-trip' && durationRange) {
        const bestPriceResult = await this.getBestPriceForDateWithDurationRange(
          flightPrices,
          currentDate,
          durationRange,
          tripType,
          'economy' // Use economy class for chart data
        );
        if (bestPriceResult.returnDate && bestPriceResult.duration) {
          returnDate = bestPriceResult.returnDate;
          bestPrice = bestPriceResult.price;
          bestDuration = bestPriceResult.duration;
        } else {
          // Fallback: ใช้ค่าเฉลี่ยถ้าไม่เจอราคา
          const avgDuration = (durationRange.min + durationRange.max) / 2;
          returnDate = addDays(currentDate, Math.round(avgDuration));
          bestDuration = Math.round(avgDuration);
        }
      }

      // ✅ แสดงเฉพาะวันที่มีข้อมูลจริง (price > 0) ในช่วงที่ต้องการ
      // แต่ถ้าเป็นวันที่ที่เลือก (startDate) ให้แสดงเสมอ แม้ไม่มีข้อมูล เพื่อให้เห็น mark
      const isInRange = currentDate >= chartStartDate && currentDate <= chartEndDate;
      const hasData = price > 0;
      // ✅ ใช้ UTC date string เพื่อให้ตรงกับการ match ข้อมูลด้านบน
      const startDateStr = startDate ? startDate.toISOString().split('T')[0] : null;
      const isSelectedDate = startDateStr === currentDateStr;

      // แสดงเฉพาะวันที่อยู่ในช่วงที่ต้องการ และมีข้อมูลจริง
      // หรือถ้าเป็นวันที่ที่เลือก ให้แสดงเสมอ (แม้ไม่มีข้อมูล) เพื่อให้เห็น mark
      // Note: สำหรับ round-trip ใช้ราคาที่คำนวณจาก durationRange
      if (isInRange && (hasData || isSelectedDate)) {
        // สำหรับ round-trip: ใช้ราคาที่คำนวณจาก durationRange
        // สำหรับ one-way: ใช้ราคาจาก matchingFlight
        const finalPrice = (tripType === 'round-trip' && bestPrice > 0) ? bestPrice : price;
        
        data.push({
          startDate: this.formatThaiDateShort(currentDate),
          returnDate: returnDate ? this.formatThaiDateShort(returnDate) : '',
          //price: Math.round(price * passengerCount), // Multiply by passengerCount to match flightPrices
          // price: Math.round(calculatePriceWithDiscounts(price, passengers)),
          //price: Math.round(this.calculatePriceWithDiscounts(price, passengers)),
          price: Math.round(finalPrice),
          season: flight?.season || 'normal',
          duration: bestDuration !== undefined ? bestDuration : undefined,
        });
      }

      currentDate = addDays(currentDate, 1);
    }

    return data;
  }

//---------------------------------------------------------------------------------------------------------------------

/**
   * Calculate price comparison (before/after)
   * Uses baseStartDate (userSelectedDate or recommendedStartDate) as the reference point
   * Now includes holiday/festival multiplier and travel class multiplier
   * ✅ แก้ไข: ใช้ durationRange แทน avgDuration เพื่อคำนวณราคาสำหรับทุกค่าที่เป็นไปได้
   */
  private async calculatePriceComparison(
    flightPrices: any[],
    baseStartDate: Date,  // ✅ เปลี่ยนชื่อเป็น baseStartDate (อาจเป็น userSelectedDate หรือ recommendedStartDate)
    _baseEndDate: Date, // Prefixed with _ to indicate intentionally unused
    durationRange: { min: number; max: number }, // ✅ เปลี่ยนจาก avgDuration เป็น durationRange
    tripType: 'one-way' | 'round-trip',
    //passengerCount: number,
    passengers: any,
    travelClass: 'economy' | 'business' | 'first' = 'economy'
  ): Promise<PriceComparison> {
    const comparisonDays = FlightAnalysisService.PRICE_COMPARISON_DAYS;
    const beforeStartDate = addDays(baseStartDate, -comparisonDays);  // ✅ ใช้ baseStartDate
    const afterStartDate = addDays(baseStartDate, comparisonDays);    // ✅ ใช้ baseStartDate

    // ✅ ใช้ราคาของ baseStartDate (วันที่ที่ส่งมา) เป็นฐานในการเปรียบเทียบ
    // คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange แล้วเลือกที่ถูกที่สุด
    const basePriceResult = await this.getBestPriceForDateWithDurationRange(
      flightPrices,
      baseStartDate,
      durationRange,
      tripType,
      travelClass
    );
    const basePrice = basePriceResult.price;
    // ✅ หาชื่อสายการบินของราคาปัจจุบัน
    const baseAirline = this.getAirlineForDate(
      flightPrices,
      baseStartDate,
      tripType
    );
    // ✅ คำนวณราคาสำหรับทุกค่าที่เป็นไปได้ในช่วง durationRange แล้วเลือกที่ถูกที่สุด
    const beforePriceResult = await this.getBestPriceForDateWithDurationRange(
      flightPrices,
      beforeStartDate,
      durationRange,
      tripType,
      travelClass
    );
    const beforePrice = beforePriceResult.price;
    const afterPriceResult = await this.getBestPriceForDateWithDurationRange(
      flightPrices,
      afterStartDate,
      durationRange,
      tripType,
      travelClass
    );
    const afterPrice = afterPriceResult.price;

    // Calculate differences and percentages
    // Handle edge cases: if basePrice is 0 or invalid, use fallback logic
    let beforeDifference = 0;
    let beforePercentage = 0;
    let afterDifference = 0;
    let afterPercentage = 0;

    if (basePrice > 0) {
      // Normal case: we have a valid base price
      // ✅ เปรียบเทียบกับ basePrice (ราคาของวันที่ที่ส่งมา)
      beforeDifference = beforePrice - basePrice;
      beforePercentage = Math.round((beforeDifference / basePrice) * 100);

      afterDifference = afterPrice - basePrice;
      afterPercentage = Math.round((afterDifference / basePrice) * 100);
    } else {
      // Edge case: no data for base date
      // If we have data for before/after dates, show comparison relative to them
      if (beforePrice > 0 && afterPrice > 0) {
        // Use average of before and after as reference
        const avgPrice = (beforePrice + afterPrice) / 2;
        beforeDifference = beforePrice - avgPrice;
        beforePercentage = Math.round((beforeDifference / avgPrice) * 100);
        afterDifference = afterPrice - avgPrice;
        afterPercentage = Math.round((afterDifference / avgPrice) * 100);
      } else if (beforePrice > 0) {
        // Only before price available
        beforeDifference = 0;
        beforePercentage = 0;
        afterDifference = afterPrice - beforePrice;
        afterPercentage = afterPrice > 0 ? Math.round((afterDifference / beforePrice) * 100) : 0;
      } else if (afterPrice > 0) {
        // Only after price available
        beforeDifference = beforePrice - afterPrice;
        beforePercentage = beforePrice > 0 ? Math.round((beforeDifference / afterPrice) * 100) : 0;
        afterDifference = 0;
        afterPercentage = 0;
      }
      // If all prices are 0, differences and percentages remain 0
    }

    // Note: getPriceForDate returns price directly from database (already filtered by travel_class)
    // Ensure all values are numbers (not null, undefined, or NaN)
    // Note: Multiply by passengerCount to match flightPrices display in frontend

    // const safeBasePrice = (isNaN(basePrice) || basePrice == null) ? 0
    //   : Math.round(basePrice * passengerCount);
    // const safeBeforePrice = (isNaN(beforePrice) || beforePrice == null) ? 0
    //   : Math.round(beforePrice * passengerCount);
    // const safeAfterPrice = (isNaN(afterPrice) || afterPrice == null) ? 0
    //   : Math.round(afterPrice * passengerCount);
    const safeBasePrice = (isNaN(basePrice) || basePrice == null) ? 0
      : Math.round(this.calculatePriceWithDiscounts(basePrice, passengers));
    const safeBeforePrice = (isNaN(beforePrice) || beforePrice == null) ? 0
      : Math.round(this.calculatePriceWithDiscounts(beforePrice, passengers));
    const safeAfterPrice = (isNaN(afterPrice) || afterPrice == null) ? 0
      : Math.round(this.calculatePriceWithDiscounts(afterPrice, passengers));

    //   const safeBeforeDifference = (isNaN(beforeDifference) || beforeDifference == null) ? 0
    //   : Math.round(beforeDifference * passengerCount);
    // const safeAfterDifference = (isNaN(afterDifference) || afterDifference == null) ? 0
    //   : Math.round(afterDifference * passengerCount);
    const safeBeforeDifference = (isNaN(beforeDifference) || beforeDifference == null) ? 0
      : Math.round(beforeDifference);
    const safeAfterDifference = (isNaN(afterDifference) || afterDifference == null) ? 0
      : Math.round(afterDifference);


    // const safeBeforeDifference = (isNaN(beforeDifference) || beforeDifference == null) ? 0
    //   : Math.round(this.calculatePriceWithDiscounts(beforeDifference, passengers));
    // const safeAfterDifference = (isNaN(afterDifference) || afterDifference == null) ? 0
    //   : Math.round(this.calculatePriceWithDiscounts(afterDifference, passengers));
    const safeBeforePercentage = (isNaN(beforePercentage) || beforePercentage == null) ? 0 : beforePercentage;
    const safeAfterPercentage = (isNaN(afterPercentage) || afterPercentage == null) ? 0 : afterPercentage;

    // ✅ คำนวณวันกลับจาก beforePriceResult และ afterPriceResult
    const beforeEndDate = beforePriceResult.returnDate || beforeStartDate;
    const afterEndDate = afterPriceResult.returnDate || afterStartDate;

    return {
      basePrice: safeBasePrice > 0 ? safeBasePrice : undefined,  // ✅ ส่ง basePrice ไปยัง frontend
      baseAirline: baseAirline || undefined,  // ✅ ส่ง baseAirline ไปยัง frontend
      ifGoBefore: {
        date: this.formatThaiDateRange(beforeStartDate, beforeEndDate, tripType),
        price: safeBeforePrice,
        difference: safeBeforeDifference,
        percentage: safeBeforePercentage,
      },
      ifGoAfter: {
        date: this.formatThaiDateRange(afterStartDate, afterEndDate, tripType),
        price: safeAfterPrice,
        difference: safeAfterDifference,
        percentage: safeAfterPercentage,
      },
    };
  }

  //------------------------------------------------------------------------------------------------------------

  /**
   * Get month number (1-12) from Thai month name
   * Supports both full name and partial match
   */
  private getMonthIndexFromThaiName(thaiMonthName: string): number {
    const thaiMonths = [
      'มกราคม',
      'กุมภาพันธ์',
      'มีนาคม',
      'เมษายน',
      'พฤษภาคม',
      'มิถุนายน',
      'กรกฎาคม',
      'สิงหาคม',
      'กันยายน',
      'ตุลาคม',
      'พฤศจิกายน',
      'ธันวาคม',
    ];

    // Try exact match first
    let index = thaiMonths.findIndex(m => m === thaiMonthName);
    if (index !== -1) {
      return index + 1; // ✅ คืนค่า 1-12 แทน 0-11
    }

    // Try partial match (for cases where month name might be split or have extra characters)
    index = thaiMonths.findIndex(m => thaiMonthName.includes(m) || m.includes(thaiMonthName));
    if (index !== -1) {
      return index + 1; // ✅ คืนค่า 1-12 แทน 0-11
    }

    return -1;
  }

//------------------------------------------------------------------------------------------------------------

/**
   * Format Thai date
   */
  private formatThaiDate(date: Date): string {
    const thaiMonths = [
      'มกราคม',
      'กุมภาพันธ์',
      'มีนาคม',
      'เมษายน',
      'พฤษภาคม',
      'มิถุนายน',
      'กรกฎาคม',
      'สิงหาคม',
      'กันยายน',
      'ตุลาคม',
      'พฤศจิกายน',
      'ธันวาคม',
    ];

    // ✅ ใช้ UTC methods เพื่อให้สอดคล้องกับ date ที่เป็น UTC date (T00:00:00.000Z)
    // เพราะ date ที่ส่งมาเป็น UTC date จาก parseISO(dateOnly + 'T00:00:00.000Z')
    return `${date.getUTCDate()} ${thaiMonths[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }


//------------------------------------------------------------------------------------------------------------

  /**
   * Get airline name for a specific date
   */
  private getAirlineForDate(
    flightPrices: any[],
    date: Date,
    tripType: 'one-way' | 'round-trip'
  ): string | null {
    // ✅ ใช้ UTC methods เพื่อหลีกเลี่ยง timezone issues
    // เพราะ date ที่ส่งมาเป็น UTC date (T00:00:00.000Z)
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const matchingFlights = flightPrices.filter(
      (fp) => {
        // ✅ ใช้ UTC methods สำหรับ departure_date ด้วย
        const fpDate = fp.departure_date instanceof Date
          ? fp.departure_date
          : new Date(fp.departure_date);
        const fpYear = fpDate.getUTCFullYear();
        const fpMonth = String(fpDate.getUTCMonth() + 1).padStart(2, '0');
        const fpDay = String(fpDate.getUTCDate()).padStart(2, '0');
        const fpDateStr = `${fpYear}-${fpMonth}-${fpDay}`;

        return fpDateStr === dateStr && fp.trip_type === tripType;
      }
    );

    if (matchingFlights.length === 0) {
      return null;
    }

    const cheapest = matchingFlights.reduce((best, current) =>
      current.price < best.price ? current : best
    );

    return cheapest.airline_name_th || cheapest.airline_name || null;
  }

//------------------------------------------------------------------------------------------------------------

  /**
   * Calculate seasons from flight prices using price_level
   * Uses price_level field from flight data to determine season classification
   */
  // private async calculateSeasonsFromFlightPricesWithDemand(
  //   flightPrices: any[],
  //   _routeId: number, // Reserved for future use (e.g., route-specific adjustments)
  //   _weatherData: Map<string, number> = new Map(), // Deprecated - no longer used
  //   _holidayData: Map<string, number> = new Map(), // Deprecated - no longer used
  //   origin?: string | string[], // Origin airport code for logging
  //   destination?: string // Destination airport code for logging
  // ): Promise<SeasonData[]> {
  //   if (flightPrices.length === 0) {
  //     return this.getEmptySeasons();
  //   }

  //   // ✅ Group flight prices by month and collect price_level values
  //   // Note: flightPrices come from database (flight_prices table) via FlightModel.getFlightPrices()
  //   // Prices are real data stored in database, not hardcoded or calculated
  //   const monthPrices: Record<number, number[]> = {};
  //   const monthPriceLevels: Record<number, string[]> = {}; // Track price_level values per month
  //   const monthPeriods: Record<number, string> = {}; // Map month to period (YYYY-MM)

  //   console.log(`[FlightAnalysis] 📊 Total flight prices received: ${flightPrices.length}`);
    
  //   // Debug: Check if price_level is available
  //   const priceLevelSample = flightPrices.slice(0, 10).map((fp: any) => ({
  //     date: fp.departure_date,
  //     price_level: fp.price_level,
  //     has_price_level: !!fp.price_level,
  //     price: fp.price
  //   }));
  //   const priceLevelStats = {
  //     total: flightPrices.length,
  //     with_price_level: flightPrices.filter((fp: any) => fp.price_level).length,
  //     without_price_level: flightPrices.filter((fp: any) => !fp.price_level).length,
  //     sample: priceLevelSample
  //   };
  //   console.log(`[FlightAnalysis] 🔍 Price_level statistics:`, JSON.stringify(priceLevelStats, null, 2));

  //   flightPrices.forEach((fp: any) => {
  //     const departureDate = new Date(fp.departure_date);
  //     const month = departureDate.getUTCMonth() + 1; // 1-12
  //     const period = format(departureDate, 'yyyy-MM');

  //     if (!monthPrices[month]) {
  //       monthPrices[month] = [];
  //       monthPriceLevels[month] = [];
  //       // ✅ Fix: Set period only once (use first occurrence, not last)
  //       monthPeriods[month] = period;
  //     }

  //     // ✅ Use price from database (fp.price from flight_prices table)
  //     // ✅ Fix: Ensure price is a valid number
  //     const price = typeof fp.price === 'number' ? fp.price : parseFloat(fp.price);
  //     if (!isNaN(price) && price > 0) {
  //       monthPrices[month].push(price);
  //     }

  //     // ✅ Collect price_level values for season determination
  //     if (fp.price_level && typeof fp.price_level === 'string') {
  //       monthPriceLevels[month].push(fp.price_level.toLowerCase());
  //     } else {
  //       // Debug: Log when price_level is missing
  //       if (monthPrices[month].length === 1) { // Log only for first flight in each month to avoid spam
  //         console.log(`[FlightAnalysis] ⚠️  Missing price_level for flight on ${fp.departure_date} (month ${month})`);
  //       }
  //     }
  //   });

  //   // ✅ Log price_level distribution by month
  //   const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  //   console.log(`[FlightAnalysis] 📊 Price_level distribution by month:`);
  //   Object.keys(monthPriceLevels).sort((a, b) => parseInt(a) - parseInt(b)).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const levels = monthPriceLevels[month];
  //     if (levels.length > 0) {
  //       const levelCounts: Record<string, number> = {};
  //       levels.forEach(level => {
  //         levelCounts[level] = (levelCounts[level] || 0) + 1;
  //       });
  //       console.log(`  ${monthNames[month - 1]}: ${levels.length} flights with price_level - ${JSON.stringify(levelCounts)}`);
  //     } else {
  //       console.log(`  ${monthNames[month - 1]}: ⚠️  No price_level data (${monthPrices[month]?.length || 0} flights without price_level)`);
  //     }
  //   });

  //   // ✅ Log flight prices distribution by month
  //   console.log(`[FlightAnalysis] 📅 Flight prices by month:`);
  //   Object.keys(monthPrices).sort((a, b) => parseInt(a) - parseInt(b)).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const prices = monthPrices[month];
  //     const period = monthPeriods[month];

  //     // ✅ Fix: Ensure prices are valid before calculating average
  //     const validPrices = prices.filter(p => typeof p === 'number' && !isNaN(p) && p > 0);
  //     if (validPrices.length > 0) {
  //       const avgPrice = validPrices.reduce((sum, p) => sum + p, 0) / validPrices.length;
  //       console.log(`  ${monthNames[month - 1]} (${period}): ${prices.length} flights, avg: ฿${Math.round(avgPrice).toLocaleString()}, range: ฿${Math.min(...validPrices).toLocaleString()} - ฿${Math.max(...validPrices).toLocaleString()}`);
  //     } else {
  //       console.warn(`  ${monthNames[month - 1]} (${period}): ${prices.length} flights, but no valid prices!`);
  //     }
  //   });

  //   // ✅ Log missing months
  //   const missingMonths: number[] = [];
  //   for (let i = 1; i <= 12; i++) {
  //     if (!monthPrices[i] || monthPrices[i].length === 0) {
  //       missingMonths.push(i);
  //     }
  //   }
  //   if (missingMonths.length > 0) {
  //     console.warn(`[FlightAnalysis] ⚠️  Missing flight prices for months: ${missingMonths.map(m => monthNames[m - 1]).join(', ')}`);
  //   }

  //   // ✅ Calculate average price for each month from database prices
  //   // This is used for price percentile calculation (60% weight in season calculation)
  //   const monthAvgPrices: Record<number, number> = {};
  //   Object.keys(monthPrices).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const prices = monthPrices[month];

  //     // ✅ Fix: Ensure prices array is not empty and contains valid numbers
  //     if (prices && prices.length > 0) {
  //       const validPrices = prices.filter(p => typeof p === 'number' && !isNaN(p) && p > 0);
  //       if (validPrices.length > 0) {
  //         monthAvgPrices[month] = validPrices.reduce((sum, p) => sum + p, 0) / validPrices.length;
  //       } else {
  //         console.warn(`[FlightAnalysis] ⚠️  No valid prices for month ${monthNames[month - 1]}`);
  //       }
  //     }
  //   });

  //   // ✅ Log average prices for debugging
  //   if (Object.keys(monthAvgPrices).length > 0) {
  //     console.log(`[FlightAnalysis] 💵 Average prices by month:`);
  //     Object.keys(monthAvgPrices).sort((a, b) => parseInt(a) - parseInt(b)).forEach(monthStr => {
  //       const month = parseInt(monthStr);
  //       const avgPrice = monthAvgPrices[month];
  //       console.log(`  ${monthNames[month - 1]}: ฿${Math.round(avgPrice).toLocaleString()}`);
  //     });
  //   }

  //   // ✅ Try to get pre-calculated price percentiles from route_price_statistics
  //   const { RoutePriceStatisticsModel } = await import('../models/RoutePriceStatistics');
  //   const { FlightModel } = await import('../models/Flight');

  //   // Get route ID
  //   // Handle origin as string or string[] (Bangkok has both BKK and DMK)
  //   const originStr = Array.isArray(origin) ? origin[0] : origin;
  //   const route = originStr && destination ? await FlightModel.getRoute(originStr, destination) : null;
  //   const routeId = route?.id;

  //   const pricePercentileMap = new Map<string, number>();
  //   if (routeId) {
  //     const priceStatsMap = await RoutePriceStatisticsModel.getRoutePriceStatisticsForPeriods(
  //       routeId,
  //       Object.values(monthPeriods)
  //     );

  //     priceStatsMap.forEach((stats, period) => {
  //       if (stats.price_percentile !== null && stats.price_percentile !== undefined) {
  //         pricePercentileMap.set(period, stats.price_percentile);
  //       }
  //     });
  //   }

  //   // Get all average prices to calculate price percentiles (for fallback or missing periods)
  //   const allAvgPrices = Object.values(monthAvgPrices);
  //   if (allAvgPrices.length === 0) {
  //     return this.getEmptySeasons();
  //   }

  //   // Calculate price percentiles for reference (used in percentile calculation for missing periods)
  //   const sortedPrices = [...allAvgPrices].sort((a, b) => a - b);

  //   // Calculate multi-factor season score for each month
  //   const monthSeasonScores: Record<number, number> = {};

  //   Object.keys(monthAvgPrices).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const avgPrice = monthAvgPrices[month];
  //     const period = monthPeriods[month];

  //     // ✅ Determine season from price_level values for this month
  //     // Use weighted average based on price_level distribution
  //     const priceLevels = monthPriceLevels[month] || [];
  //     let seasonScore: number;

  //     if (priceLevels.length > 0) {
  //       // Count occurrences of each price_level
  //       const levelCounts: Record<string, number> = {};
  //       priceLevels.forEach(level => {
  //         levelCounts[level] = (levelCounts[level] || 0) + 1;
  //       });

  //       // Calculate weighted average score based on price_level distribution
  //       // "low" = 20, "typical" = 50, "high" = 80
  //       const totalFlights = priceLevels.length;
  //       let weightedScore = 0;
        
  //       if (levelCounts['low']) {
  //         weightedScore += (levelCounts['low'] / totalFlights) * 20;
  //       }
  //       if (levelCounts['typical']) {
  //         weightedScore += (levelCounts['typical'] / totalFlights) * 50;
  //       }
  //       if (levelCounts['high']) {
  //         weightedScore += (levelCounts['high'] / totalFlights) * 80;
  //       }

  //       seasonScore = Math.round(weightedScore);

  //       const determinedSeason = seasonScore <= 33 ? 'low' : seasonScore >= 67 ? 'high' : 'normal';
  //       console.log(`[FlightAnalysis] 📅 Month ${month} (${period}): price_level distribution ${JSON.stringify(levelCounts)} (${totalFlights} flights) -> weighted score=${seasonScore} -> season=${determinedSeason}`);
  //     } else {
  //       // Fallback: Use price percentile if no price_level data available
  //       let pricePercentile: number;
  //       if (pricePercentileMap.has(period)) {
  //         pricePercentile = pricePercentileMap.get(period)!;
  //       } else {
  //         // Fallback: Calculate price percentile (0-100)
  //         pricePercentile = (sortedPrices.filter(p => p <= avgPrice).length / sortedPrices.length) * 100;
  //       }
  //       seasonScore = pricePercentile;
  //       console.log(`[FlightAnalysis] Month ${month} (${period}): No price_level data, using price percentile -> score=${seasonScore.toFixed(2)}`);
  //     }

  //     monthSeasonScores[month] = seasonScore;

  //     // Log season calculation details for debugging
  //     if (month === 1) { // Log for January only to avoid too much output
  //       const priceLevels = monthPriceLevels[month] || [];
  //       const levelCounts: Record<string, number> = {};
  //       priceLevels.forEach(level => {
  //         levelCounts[level] = (levelCounts[level] || 0) + 1;
  //       });
  //       console.log(`[FlightAnalysis] Season calculation for month ${month} (${period}):`, {
  //         route: `${origin} → ${destination}`,
  //         avgPrice,
  //         priceLevels: levelCounts,
  //         seasonScore: seasonScore.toFixed(2),
  //       });
  //     }
  //   });

  //   // Classify months based on season scores
  //   // ✅ Use absolute thresholds based on price_level mapping instead of percentile
  //   // This ensures consistent season classification regardless of data distribution
  //   // low (score 20) → Low Season
  //   // typical (score 50) → Normal Season  
  //   // high (score 80) → High Season
    
  //   const scoreLowThreshold = 33;  // Below this = Low Season (score 20 is below 33)
  //   const scoreHighThreshold = 67; // Above this = High Season (score 80 is above 67)
  //   // Between 33-67 = Normal Season (score 50 is in this range)

  //   const monthsWithPriceLevel = Object.keys(monthPriceLevels).filter(m => monthPriceLevels[parseInt(m)].length > 0).length;
  //   const monthsWithoutPriceLevel = Object.keys(monthAvgPrices).length - monthsWithPriceLevel;
  //   console.log(`[FlightAnalysis] 💵 Season determination: ${monthsWithPriceLevel} months from price_level, ${monthsWithoutPriceLevel} months from price percentile`);
  //   console.log(`[FlightAnalysis] 🎯 Season score thresholds (absolute): Low ≤ ${scoreLowThreshold}, High ≥ ${scoreHighThreshold}`);

  //   const monthSeasonMap: Record<number, 'low' | 'normal' | 'high'> = {};

  //   Object.keys(monthSeasonScores).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const score = monthSeasonScores[month];

  //     if (score <= scoreLowThreshold) {
  //       monthSeasonMap[month] = 'low';
  //     } else if (score >= scoreHighThreshold) {
  //       monthSeasonMap[month] = 'high';
  //     } else {
  //       monthSeasonMap[month] = 'normal';
  //     }
  //   });

  //   // ✅ Log season classification for each month
  //   console.log(`[FlightAnalysis] 🗓️  Season classification by month:`);
  //   Object.keys(monthSeasonScores).sort((a, b) => parseInt(a) - parseInt(b)).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const score = monthSeasonScores[month];
  //     const season = monthSeasonMap[month] || 'normal';
  //     const period = monthPeriods[month] || 'N/A';
  //     console.log(`  ${monthNames[month - 1]} (${period}): ${season.toUpperCase()} (score: ${score.toFixed(2)})`);
  //   });

  //   // Group months by season
  //   // ✅ Only include months that have actual data (monthSeasonScores)
  //   const seasonMonths: Record<'low' | 'normal' | 'high', number[]> = {
  //     low: [],
  //     normal: [],
  //     high: [],
  //   };

  //   // Only assign months that have data (exist in monthSeasonScores)
  //   Object.keys(monthSeasonScores).forEach(monthStr => {
  //     const month = parseInt(monthStr);
  //     const season = monthSeasonMap[month];
  //     if (season) {
  //       seasonMonths[season].push(month);
  //     }
  //   });

  //   // Sort months within each season
  //   seasonMonths.low.sort((a, b) => a - b);
  //   seasonMonths.normal.sort((a, b) => a - b);
  //   seasonMonths.high.sort((a, b) => a - b);

  //   // Group prices by season
  //   const seasonPrices: {
  //     low: number[];
  //     normal: number[];
  //     high: number[];
  //   } = {
  //     low: [],
  //     normal: [],
  //     high: [],
  //   };

  //   flightPrices.forEach((fp: any) => {
  //     const departureDate = new Date(fp.departure_date);
  //     const month = departureDate.getUTCMonth() + 1;
  //     const season = monthSeasonMap[month] || 'normal';

  //     if (seasonPrices[season]) {
  //       seasonPrices[season].push(fp.price);
  //     }
  //   });

  //   // ✅ Log prices grouped by season
  //   console.log(`[FlightAnalysis] 💰 Prices grouped by season:`);
  //   console.log(`  Low: ${seasonPrices.low.length} flights (${seasonPrices.low.length > 0 ? `฿${Math.min(...seasonPrices.low).toLocaleString()} - ฿${Math.max(...seasonPrices.low).toLocaleString()}` : 'No data'})`);
  //   console.log(`  Normal: ${seasonPrices.normal.length} flights (${seasonPrices.normal.length > 0 ? `฿${Math.min(...seasonPrices.normal).toLocaleString()} - ฿${Math.max(...seasonPrices.normal).toLocaleString()}` : 'No data'})`);
  //   console.log(`  High: ${seasonPrices.high.length} flights (${seasonPrices.high.length > 0 ? `฿${Math.min(...seasonPrices.high).toLocaleString()} - ฿${Math.max(...seasonPrices.high).toLocaleString()}` : 'No data'})`);

  //   // Helper function to get price range for a season
  //   const getPriceRangeForSeason = (seasonType: 'low' | 'normal' | 'high') => {
  //     const prices = seasonPrices[seasonType];
  //     if (prices.length > 0) {
  //       const result = {
  //         min: Math.min(...prices),
  //         max: Math.max(...prices),
  //       };
  //       console.log(`[FlightAnalysis] ✅ ${seasonType.toUpperCase()} season: Found ${prices.length} prices, range: ฿${result.min.toLocaleString()} - ฿${result.max.toLocaleString()}`);
  //       return result;
  //     }

  //     // ✅ Fallback: Try to find prices from flightPrices directly
  //     // This handles cases where season has months but no flights in the queried date range
  //     const filteredFlights = flightPrices.filter((fp: any) => {
  //       const departureDate = new Date(fp.departure_date);
  //       const month = departureDate.getUTCMonth() + 1;
  //       return monthSeasonMap[month] === seasonType;
  //     });

  //     if (filteredFlights.length > 0) {
  //       const flightPricesForSeason = filteredFlights.map((fp: any) => fp.price);
  //       const result = {
  //         min: Math.min(...flightPricesForSeason),
  //         max: Math.max(...flightPricesForSeason),
  //       };
  //       console.log(`[FlightAnalysis] ✅ ${seasonType.toUpperCase()} season (fallback): Found ${filteredFlights.length} flights, range: ฿${result.min.toLocaleString()} - ฿${result.max.toLocaleString()}`);
  //       return result;
  //     }

  //     // ✅ Log detailed information when no prices found
  //     const seasonMonthsForType = seasonMonths[seasonType];
  //     const monthsWithData = seasonMonthsForType.filter(m => monthPrices[m] && monthPrices[m].length > 0);
  //     const monthsWithoutData = seasonMonthsForType.filter(m => !monthPrices[m] || monthPrices[m].length === 0);

  //     console.warn(`[FlightAnalysis] ⚠️  ${seasonType.toUpperCase()} season: No flight prices found!`);
  //     console.warn(`  Months assigned to ${seasonType}: ${seasonMonthsForType.map(m => monthNames[m - 1]).join(', ')}`);
  //     console.warn(`  Months with data: ${monthsWithData.map(m => monthNames[m - 1]).join(', ') || 'None'}`);
  //     console.warn(`  Months without data: ${monthsWithoutData.map(m => monthNames[m - 1]).join(', ') || 'None'}`);
  //     console.warn(`  Total flight prices queried: ${flightPrices.length}`);
  //     console.warn(`  Date range: ${flightPrices.length > 0 ? `${format(new Date(flightPrices[0].departure_date), 'yyyy-MM-dd')} to ${format(new Date(flightPrices[flightPrices.length - 1].departure_date), 'yyyy-MM-dd')}` : 'No data'}`);

  //     // ❌ REMOVED: Don't use average price as fallback - this causes all seasons to show same price
  //     // If no flights found for this season, return 0 (frontend will handle display)
  //     // This ensures each season shows its actual price from database, not a generic fallback
  //     return { min: 0, max: 0 };
  //   };

  //   // Build seasons array
  //   const seasons: SeasonData[] = [
  //     {
  //       type: 'low',
  //       months: seasonMonths.low.map(m => this.getThaiMonthName(m)),
  //       priceRange: getPriceRangeForSeason('low'),
  //       bestDeal: this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, 'low'),
  //       description: 'ราคาถูกที่สุดของปี เหมาะสำหรับผู้ที่มีความยืดหยุ่นในการเดินทาง',
  //     },
  //     {
  //       type: 'normal',
  //       months: seasonMonths.normal.map(m => this.getThaiMonthName(m)),
  //       priceRange: getPriceRangeForSeason('normal'),
  //       bestDeal: this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, 'normal'),
  //       description: 'ราคาปานกลาง อากาศดี เหมาะสำหรับการท่องเที่ยว',
  //     },
  //     {
  //       type: 'high',
  //       months: seasonMonths.high.map(m => this.getThaiMonthName(m)),
  //       priceRange: getPriceRangeForSeason('high'),
  //       bestDeal: this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, 'high'),
  //       description: 'ช่วงเทศกาลและปิดเทอม ราคาสูงสุด แนะนำจองล่วงหน้า',
  //     },
  //   ];

  //   return seasons;
  // }








  













  /**
   * Convert database season configs to SeasonData format
   * @deprecated Removed - no longer using SeasonConfigModel
   */
  // @ts-ignore - Deprecated method, kept for reference
  private convertDbConfigsToSeasonData_DEPRECATED(
    dbConfigs: any[],
    flightPrices: any[]
  ): SeasonData[] {
    // Debug logging
    console.log(`[FlightAnalysis] convertDbConfigsToSeasonData:`, {
      dbConfigsCount: dbConfigs.length,
      flightPricesCount: flightPrices.length,
      dbConfigsSample: dbConfigs.slice(0, 3).map(c => ({
        month: c.month,
        season: c.season,
        min_price: c.min_price,
        max_price: c.max_price,
        avg_price: c.avg_price,
      })),
    });

    // Group by season type
    const seasonGroups: Record<string, any[]> = {
      low: [],
      normal: [],
      high: [],
    };

    dbConfigs.forEach(config => {
      seasonGroups[config.season].push(config);
    });

    // Build monthSeasonMap from dbConfigs (more accurate than fp.season from database)
    const monthSeasonMap: Record<number, 'low' | 'normal' | 'high'> = {};
    dbConfigs.forEach(config => {
      monthSeasonMap[config.month] = config.season;
    });

    console.log(`[FlightAnalysis] monthSeasonMap:`, monthSeasonMap);

    // Default months for each season (fallback when no configs available)
    const defaultSeasonMonths: Record<string, string[]> = {
      low: ['พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน'],
      normal: ['มีนาคม', 'เมษายน', 'ตุลาคม'],
      high: ['มกราคม', 'กุมภาพันธ์', 'พฤศจิกายน', 'ธันวาคม'],
    };

    // Convert to SeasonData format
    return ['low', 'normal', 'high'].map(seasonType => {
      const configs = seasonGroups[seasonType];
      const months = configs.length > 0
        ? configs.map(c => this.getThaiMonthName(c.month))
        : defaultSeasonMonths[seasonType] || [];

      // Get prices from flight prices for this season (filter by monthSeasonMap for accuracy)
      const seasonPrices = flightPrices
        .filter((fp: any) => {
          const fpDate = fp.departure_date instanceof Date
            ? fp.departure_date
            : new Date(fp.departure_date);
          const fpMonth = fpDate.getUTCMonth() + 1; // ✅ แปลง 0-11 เป็น 1-12
          // Use monthSeasonMap if available (from dbConfigs), otherwise fallback to configs
          if (Object.keys(monthSeasonMap).length > 0) {
            return monthSeasonMap[fpMonth] === seasonType;
          }
          if (configs.length > 0) {
            return configs.some(c => c.month === fpMonth);
          }
          // If no configs, check if month matches default season months
          if (defaultSeasonMonths[seasonType]) {
            return defaultSeasonMonths[seasonType].some(monthName => {
              const monthNumber = this.getMonthIndexFromThaiName(monthName);
              return monthNumber === fpMonth; // ✅ แก้จาก monthIndex เป็น monthNumber
            });
          }
          return false;
        })
        .map((fp: any) => fp.price)
        .filter((price: number) => price > 0); // Filter out zero prices

      // ✅ Use database price ranges if available and valid (not 0), otherwise calculate from flight prices
      // Filter out configs with price 0 (default configs with no data)
      const validConfigs = configs.filter(c => c.min_price > 0 && c.max_price > 0);

      let minPrice: number;
      let maxPrice: number;

      if (validConfigs.length > 0) {
        // Use database configs (most accurate)
        minPrice = Math.min(...validConfigs.map(c => c.min_price));
        maxPrice = Math.max(...validConfigs.map(c => c.max_price));
        console.log(`[FlightAnalysis] ${seasonType} season: Using database configs (${validConfigs.length} configs), price range: ${minPrice} - ${maxPrice}`);
      } else if (seasonPrices.length > 0) {
        // Use calculated prices from flight data
        minPrice = Math.min(...seasonPrices);
        maxPrice = Math.max(...seasonPrices);
        console.log(`[FlightAnalysis] ${seasonType} season: Using flight prices (${seasonPrices.length} prices), price range: ${minPrice} - ${maxPrice}`);
      } else {
        // Fallback: try to get from all configs (even if 0) or use 0
        const allConfigPrices = configs.map(c => c.min_price).filter(p => p > 0);
        if (allConfigPrices.length > 0) {
          minPrice = Math.min(...allConfigPrices);
          maxPrice = Math.max(...configs.map(c => c.max_price).filter(p => p > 0));
          console.log(`[FlightAnalysis] ${seasonType} season: Using all configs (${allConfigPrices.length} prices), price range: ${minPrice} - ${maxPrice}`);
        } else {
          // Last resort: use 0 (no data available)
          minPrice = 0;
          maxPrice = 0;
          console.warn(`[FlightAnalysis] ${seasonType} season: No price data available`, {
            configsCount: configs.length,
            validConfigsCount: validConfigs.length,
            seasonPricesCount: seasonPrices.length,
            monthSeasonMapKeys: Object.keys(monthSeasonMap).length,
            flightPricesCount: flightPrices.length,
            configsSample: configs.slice(0, 3).map(c => ({
              month: c.month,
              min_price: c.min_price,
              max_price: c.max_price,
            })),
          });
        }
      }

      // Use findBestDealByMonthSeason if monthSeasonMap is available (more accurate)
      // Otherwise fallback to findBestDeal
      let bestDeal;
      if (Object.keys(monthSeasonMap).length > 0) {
        bestDeal = this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, seasonType as 'low' | 'normal' | 'high');
      } else {
        bestDeal = this.findBestDeal(flightPrices, seasonType as 'high' | 'normal' | 'low');
      }

      return {
        type: seasonType as 'high' | 'normal' | 'low',
        months,
        priceRange: {
          min: minPrice,
          max: maxPrice,
        },
        bestDeal,
        description: this.getSeasonDescription(seasonType as 'high' | 'normal' | 'low'),
      };
    });
  }

 




  /**
   * Helper method to return empty seasons
   */
  private getEmptySeasons(): SeasonData[] {
    return [
      {
        type: 'low',
        months: [],
        priceRange: { min: 0, max: 0 },
        bestDeal: { dates: '', price: 0, airline: '' },
        description: 'No data available',
      },
      {
        type: 'normal',
        months: [],
        priceRange: { min: 0, max: 0 },
        bestDeal: { dates: '', price: 0, airline: '' },
        description: 'No data available',
      },
      {
        type: 'high',
        months: [],
        priceRange: { min: 0, max: 0 },
        bestDeal: { dates: '', price: 0, airline: '' },
        description: 'No data available',
      },
    ];
  }

  /**
   * Calculate seasons from flight prices (fallback method)
   * Calculates season classification from actual price data using percentile method
   * @deprecated Use calculateSeasonsFromFlightPricesWithDemand instead
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // @ts-ignore - Deprecated method, kept for reference
  private _calculateSeasonsFromFlightPrices_DEPRECATED(flightPrices: any[]): SeasonData[] {
    if (flightPrices.length === 0) {
      // If no flight prices, return empty seasons
      return [
        {
          type: 'low',
          months: [],
          priceRange: { min: 0, max: 0 },
          bestDeal: { dates: '', price: 0, airline: '' },
          description: 'No data available',
        },
        {
          type: 'normal',
          months: [],
          priceRange: { min: 0, max: 0 },
          bestDeal: { dates: '', price: 0, airline: '' },
          description: 'No data available',
        },
        {
          type: 'high',
          months: [],
          priceRange: { min: 0, max: 0 },
          bestDeal: { dates: '', price: 0, airline: '' },
          description: 'No data available',
        },
      ];
    }

    // Group flight prices by month
    const monthPrices: Record<number, number[]> = {};

    flightPrices.forEach((fp: any) => {
      const departureDate = new Date(fp.departure_date);
      const month = departureDate.getUTCMonth() + 1; // ✅ แปลง 0-11 เป็น 1-12

      if (!monthPrices[month]) {
        monthPrices[month] = [];
      }

      monthPrices[month].push(fp.price);
    });

    // Calculate average price for each month
    const monthAvgPrices: Record<number, number> = {};
    Object.keys(monthPrices).forEach(monthStr => {
      const month = parseInt(monthStr);
      const prices = monthPrices[month];
      monthAvgPrices[month] = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    });

    // Get all average prices to calculate percentiles
    const allAvgPrices = Object.values(monthAvgPrices);
    if (allAvgPrices.length === 0) {
      // Return empty seasons if no data
      return [
        {
          type: 'low',
          months: [],
          priceRange: { min: 0, max: 0 },
          bestDeal: { dates: '', price: 0, airline: '' },
          description: 'No data available',
        },
        {
          type: 'normal',
          months: [],
          priceRange: { min: 0, max: 0 },
          bestDeal: { dates: '', price: 0, airline: '' },
          description: 'No data available',
        },
        {
          type: 'high',
          months: [],
          priceRange: { min: 0, max: 0 },
          bestDeal: { dates: '', price: 0, airline: '' },
          description: 'No data available',
        },
      ];
    }

    // Sort prices to find percentiles
    const sortedPrices = [...allAvgPrices].sort((a, b) => a - b);
    const lowThreshold = this.percentile(sortedPrices, 33);   // Bottom 33% = Low Season
    const highThreshold = this.percentile(sortedPrices, 67);  // Top 33% = High Season

    // Calculate season classification purely from price data
    // No hardcoded defaults - use statistical analysis only
    const monthSeasonMap: Record<number, 'low' | 'normal' | 'high'> = {};

    // Classify each month based on price percentiles
    Object.keys(monthAvgPrices).forEach(monthStr => {
      const month = parseInt(monthStr);
      const avgPrice = monthAvgPrices[month];

      // Classify based on percentiles
      if (avgPrice <= lowThreshold) {
        monthSeasonMap[month] = 'low';
      } else if (avgPrice >= highThreshold) {
        monthSeasonMap[month] = 'high';
      } else {
        monthSeasonMap[month] = 'normal';
      }
    });

    // Group months by season (calculated from data only)
    const seasonMonths: Record<'low' | 'normal' | 'high', number[]> = {
      low: [],
      normal: [],
      high: [],
    };

    // Assign months based on calculated classification
    for (let i = 1; i <= 12; i++) {
      const season = monthSeasonMap[i] || 'normal'; // Default to normal if no data
      seasonMonths[season].push(i);
    }

    // Sort months within each season
    seasonMonths.low.sort((a, b) => a - b);
    seasonMonths.normal.sort((a, b) => a - b);
    seasonMonths.high.sort((a, b) => a - b);

    // Group prices by calculated season (use monthSeasonMap)
    const seasonPrices: {
      low: number[];
      normal: number[];
      high: number[];
    } = {
      low: [],
      normal: [],
      high: [],
    };

    flightPrices.forEach((fp: any) => {
      const departureDate = new Date(fp.departure_date);
      const month = departureDate.getUTCMonth() + 1; // ✅ แปลง 0-11 เป็น 1-12
      const season = monthSeasonMap[month] || 'normal';

      if (seasonPrices[season]) {
        seasonPrices[season].push(fp.price);
      }
    });

    // Helper function to get price range for a season
    const getPriceRangeForSeason = (seasonType: 'low' | 'normal' | 'high') => {
      const prices = seasonPrices[seasonType];
      if (prices.length > 0) {
        return {
          min: Math.min(...prices),
          max: Math.max(...prices),
        };
      }
      // Fallback: calculate from filtered flights (same logic as bestDeal)
      const filteredFlights = flightPrices.filter((fp: any) => {
        const departureDate = new Date(fp.departure_date);
        const month = departureDate.getUTCMonth() + 1; // ✅ แปลง 0-11 เป็น 1-12
        return monthSeasonMap[month] === seasonType;
      });
      if (filteredFlights.length > 0) {
        const prices = filteredFlights.map((fp: any) => fp.price);
        return {
          min: Math.min(...prices),
          max: Math.max(...prices),
        };
      }
      return { min: 0, max: 0 };
    };

    // Use calculated months directly (no hardcoded defaults)
    // If no data for a month, it will be assigned to 'normal' as fallback
    const finalSeasonMonths: Record<'low' | 'normal' | 'high', number[]> = {
      low: [...seasonMonths.low],
      normal: [...seasonMonths.normal],
      high: [...seasonMonths.high],
    };

    // Assign any missing months to 'normal' (fallback only if no data)
    const allAssignedMonths = new Set([
      ...finalSeasonMonths.low,
      ...finalSeasonMonths.normal,
      ...finalSeasonMonths.high,
    ]);

    // Fill missing months with 'normal' as fallback (only if no data available)
    for (let i = 1; i <= 12; i++) {
      if (!allAssignedMonths.has(i)) {
        finalSeasonMonths.normal.push(i);
        allAssignedMonths.add(i);
      }
    }

    // Sort months within each season
    finalSeasonMonths.low.sort((a, b) => a - b);
    finalSeasonMonths.normal.sort((a, b) => a - b);
    finalSeasonMonths.high.sort((a, b) => a - b);

    // Debug logging
    console.log(`[FlightAnalysis] Season months breakdown:`, {
      low: finalSeasonMonths.low,
      normal: finalSeasonMonths.normal,
      high: finalSeasonMonths.high,
      monthSeasonMap: Object.keys(monthSeasonMap).map(m => `${m}:${monthSeasonMap[parseInt(m)]}`).join(', '),
    });

    // Build seasons array with dynamically calculated months
    const seasons: SeasonData[] = [
      {
        type: 'low',
        months: finalSeasonMonths.low.map(m => this.getThaiMonthName(m)),
        priceRange: getPriceRangeForSeason('low'),
        bestDeal: this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, 'low'),
        description:
          'ราคาถูกที่สุดของปี เหมาะสำหรับผู้ที่มีความยืดหยุ่นในการเดินทาง',
      },
      {
        type: 'normal',
        months: finalSeasonMonths.normal.map(m => this.getThaiMonthName(m)),
        priceRange: getPriceRangeForSeason('normal'),
        bestDeal: this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, 'normal'),
        description: 'ราคาปานกลาง อากาศดี เหมาะสำหรับการท่องเที่ยว',
      },
      {
        type: 'high',
        months: finalSeasonMonths.high.map(m => this.getThaiMonthName(m)),
        priceRange: getPriceRangeForSeason('high'),
        bestDeal: this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, 'high'),
        description: 'ช่วงเทศกาลและปิดเทอม ราคาสูงสุด แนะนำจองล่วงหน้า',
      },
    ];

    return seasons;
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sortedArr: number[], p: number): number {
    if (sortedArr.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, index)];
  }

  /**
   * Find best deal by month-season mapping (for fallback calculation)
   */
  private findBestDealByMonthSeason(
    flightPrices: any[],
    monthSeasonMap: Record<number, 'low' | 'normal' | 'high'>,
    targetSeason: 'low' | 'normal' | 'high'
  ): { dates: string; price: number; airline: string } {
    const filteredFlights = flightPrices.filter((fp: any) => {
      const departureDate = new Date(fp.departure_date);
      const month = departureDate.getUTCMonth() + 1; // ✅ แปลง 0-11 เป็น 1-12
      return monthSeasonMap[month] === targetSeason;
    });

    if (filteredFlights.length > 0) {
      const cheapest = filteredFlights.reduce((min, fp) =>
        fp.price < min.price ? fp : min
      );

      return {
        dates: this.formatThaiDate(new Date(cheapest.departure_date)),
        price: cheapest.price,
        airline: cheapest.airline_name_th || cheapest.airline_name || '',
      };
    }

    // ❌ REMOVED: Don't use average price as fallback - this causes all seasons to show same price
    // If no flights found for this season, return 0 (frontend will handle display)
    // This ensures each season shows its actual price from database, not a generic fallback
    return { dates: '', price: 0, airline: '' };
  }


  /**
   * Get Thai month name from month number (1-12)
   */
  private getThaiMonthName(month: number): string {
    const thaiMonths = [
      '', // index 0 unused (months are 1-12)
      'มกราคม',
      'กุมภาพันธ์',
      'มีนาคม',
      'เมษายน',
      'พฤษภาคม',
      'มิถุนายน',
      'กรกฎาคม',
      'สิงหาคม',
      'กันยายน',
      'ตุลาคม',
      'พฤศจิกายน',
      'ธันวาคม',
    ];
    return thaiMonths[month] || '';
  }

  /**
   * Get season description
   */
  private getSeasonDescription(season: 'high' | 'normal' | 'low'): string {
    const descriptions = {
      low: 'ราคาถูกที่สุดของปี เหมาะสำหรับผู้ที่มีความยืดหยุ่นในการเดินทาง',
      normal: 'ราคาปานกลาง อากาศดี เหมาะสำหรับการท่องเที่ยว',
      high: 'ช่วงเทศกาลและปิดเทอม ราคาสูงสุด แนะนำจองล่วงหน้า',
    };
    return descriptions[season];
  }

  /**
   * Find best deal for a season
   */
  private findBestDeal(
    flightPrices: any[],
    season: 'high' | 'normal' | 'low'
  ): { dates: string; price: number; airline: string } {
    const seasonPrices = flightPrices.filter((fp) => fp.season === season);

    if (seasonPrices.length === 0) {
      return {
        dates: '',
        price: 0,
        airline: '',
      };
    }

    const cheapest = seasonPrices.reduce((best, current) =>
      current.price < best.price ? current : best
    );

    return {
      dates: this.formatThaiDate(cheapest.departure_date),
      price: cheapest.price,
      airline: cheapest.airline_name_th || cheapest.airline_name,
    };
  }































  



  

  /**
   * Format Thai date short
   */
  private formatThaiDateShort(date: Date): string {
    const thaiMonths = [
      'ม.ค.',
      'ก.พ.',
      'มี.ค.',
      'เม.ย.',
      'พ.ค.',
      'มิ.ย.',
      'ก.ค.',
      'ส.ค.',
      'ก.ย.',
      'ต.ค.',
      'พ.ย.',
      'ธ.ค.',
    ];

    // ✅ ใช้ UTC methods เพื่อให้สอดคล้องกับ date ที่เป็น UTC date (T00:00:00.000Z)
    // เพราะ date ที่ส่งมาเป็น UTC date จาก parseISO(dateOnly + 'T00:00:00.000Z')
    return `${date.getUTCDate()} ${thaiMonths[date.getUTCMonth()]}`;
  }

  /**
   * Format Thai date range
   */
  private formatThaiDateRange(
    startDate: Date,
    endDate: Date,
    tripType?: 'one-way' | 'round-trip'
  ): string {
    if (tripType === 'one-way') {
      return this.formatThaiDate(startDate);
    }

    return `${this.formatThaiDate(startDate)} - ${this.formatThaiDate(endDate)}`;
  }

  /**
   * Get season for a specific month (month number 1-12)
   * @deprecated Currently not used, but kept for future reference
   */
  // @ts-ignore - Deprecated method, kept for reference
  private getSeasonForMonth(
    seasons: SeasonData[],
    monthNumber: number,
    flightPrices: any[]
  ): SeasonData {
    // Find which season this month belongs to
    for (const season of seasons) {
      const thaiMonthName = this.getThaiMonthName(monthNumber);
      if (season.months.includes(thaiMonthName)) {
        return season;
      }
    }

    // Fallback: determine season from flight prices in this month
    const monthFlights = flightPrices.filter((fp) => {
      const fpDate = new Date(fp.departure_date);
      return fpDate.getUTCMonth() + 1 === monthNumber; // ✅ แปลง 0-11 เป็น 1-12
    });

    if (monthFlights.length > 0) {
      // Use average price to determine season
      const avgPrice = monthFlights.reduce((sum, fp) => sum + fp.price, 0) / monthFlights.length;

      // Compare with season price ranges
      const lowSeason = seasons.find(s => s.type === 'low');
      const highSeason = seasons.find(s => s.type === 'high');

      if (lowSeason && avgPrice <= lowSeason.priceRange.max) {
        return lowSeason;
      }
      if (highSeason && avgPrice >= highSeason.priceRange.min) {
        return highSeason;
      }
    }

    // Default to normal season
    return seasons.find(s => s.type === 'normal') || seasons[0];
  }

  










  /**
   * Generate deterministic random number from a seed string
   * This ensures the same seed always produces the same "random" value
   * Used to make season calculation deterministic (same period = same season)
   * Returns a value between 0 and 1 (inclusive)
   */
  private deterministicRandom(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      const char = seed.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert hash to 0-1 range (ensure it's always in valid range)
    const normalized = Math.abs(hash) % 1000000 / 1000000;
    return normalized;
  }










  /**
   * Convert database season configs to SeasonData format
   * @deprecated Removed - no longer using SeasonConfigModel
   */
  // @ts-ignore - Deprecated method, kept for reference
  private convertDbConfigsToSeasonData_DEPRECATED(
    dbConfigs: any[],
    flightPrices: any[]
  ): SeasonData[] {
    // Debug logging
    console.log(`[FlightAnalysis] convertDbConfigsToSeasonData:`, {
      dbConfigsCount: dbConfigs.length,
      flightPricesCount: flightPrices.length,
      dbConfigsSample: dbConfigs.slice(0, 3).map(c => ({
        month: c.month,
        season: c.season,
        min_price: c.min_price,
        max_price: c.max_price,
        avg_price: c.avg_price,
      })),
    });

    // Group by season type
    const seasonGroups: Record<string, any[]> = {
      low: [],
      normal: [],
      high: [],
    };

    dbConfigs.forEach(config => {
      seasonGroups[config.season].push(config);
    });

    // Build monthSeasonMap from dbConfigs (more accurate than fp.season from database)
    const monthSeasonMap: Record<number, 'low' | 'normal' | 'high'> = {};
    dbConfigs.forEach(config => {
      monthSeasonMap[config.month] = config.season;
    });

    console.log(`[FlightAnalysis] monthSeasonMap:`, monthSeasonMap);

    // Default months for each season (fallback when no configs available)
    const defaultSeasonMonths: Record<string, string[]> = {
      low: ['พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน'],
      normal: ['มีนาคม', 'เมษายน', 'ตุลาคม'],
      high: ['มกราคม', 'กุมภาพันธ์', 'พฤศจิกายน', 'ธันวาคม'],
    };

    // Convert to SeasonData format
    return ['low', 'normal', 'high'].map(seasonType => {
      const configs = seasonGroups[seasonType];
      const months = configs.length > 0
        ? configs.map(c => this.getThaiMonthName(c.month))
        : defaultSeasonMonths[seasonType] || [];

      // Get prices from flight prices for this season (filter by monthSeasonMap for accuracy)
      const seasonPrices = flightPrices
        .filter((fp: any) => {
          const fpDate = fp.departure_date instanceof Date
            ? fp.departure_date
            : new Date(fp.departure_date);
          const fpMonth = fpDate.getUTCMonth() + 1; // ✅ แปลง 0-11 เป็น 1-12
          // Use monthSeasonMap if available (from dbConfigs), otherwise fallback to configs
          if (Object.keys(monthSeasonMap).length > 0) {
            return monthSeasonMap[fpMonth] === seasonType;
          }
          if (configs.length > 0) {
            return configs.some(c => c.month === fpMonth);
          }
          // If no configs, check if month matches default season months
          if (defaultSeasonMonths[seasonType]) {
            return defaultSeasonMonths[seasonType].some(monthName => {
              const monthNumber = this.getMonthIndexFromThaiName(monthName);
              return monthNumber === fpMonth; // ✅ แก้จาก monthIndex เป็น monthNumber
            });
          }
          return false;
        })
        .map((fp: any) => fp.price)
        .filter((price: number) => price > 0); // Filter out zero prices

      // ✅ Use database price ranges if available and valid (not 0), otherwise calculate from flight prices
      // Filter out configs with price 0 (default configs with no data)
      const validConfigs = configs.filter(c => c.min_price > 0 && c.max_price > 0);

      let minPrice: number;
      let maxPrice: number;

      if (validConfigs.length > 0) {
        // Use database configs (most accurate)
        minPrice = Math.min(...validConfigs.map(c => c.min_price));
        maxPrice = Math.max(...validConfigs.map(c => c.max_price));
        console.log(`[FlightAnalysis] ${seasonType} season: Using database configs (${validConfigs.length} configs), price range: ${minPrice} - ${maxPrice}`);
      } else if (seasonPrices.length > 0) {
        // Use calculated prices from flight data
        minPrice = Math.min(...seasonPrices);
        maxPrice = Math.max(...seasonPrices);
        console.log(`[FlightAnalysis] ${seasonType} season: Using flight prices (${seasonPrices.length} prices), price range: ${minPrice} - ${maxPrice}`);
      } else {
        // Fallback: try to get from all configs (even if 0) or use 0
        const allConfigPrices = configs.map(c => c.min_price).filter(p => p > 0);
        if (allConfigPrices.length > 0) {
          minPrice = Math.min(...allConfigPrices);
          maxPrice = Math.max(...configs.map(c => c.max_price).filter(p => p > 0));
          console.log(`[FlightAnalysis] ${seasonType} season: Using all configs (${allConfigPrices.length} prices), price range: ${minPrice} - ${maxPrice}`);
        } else {
          // Last resort: use 0 (no data available)
          minPrice = 0;
          maxPrice = 0;
          console.warn(`[FlightAnalysis] ${seasonType} season: No price data available`, {
            configsCount: configs.length,
            validConfigsCount: validConfigs.length,
            seasonPricesCount: seasonPrices.length,
            monthSeasonMapKeys: Object.keys(monthSeasonMap).length,
            flightPricesCount: flightPrices.length,
            configsSample: configs.slice(0, 3).map(c => ({
              month: c.month,
              min_price: c.min_price,
              max_price: c.max_price,
            })),
          });
        }
      }

      // Use findBestDealByMonthSeason if monthSeasonMap is available (more accurate)
      // Otherwise fallback to findBestDeal
      let bestDeal;
      if (Object.keys(monthSeasonMap).length > 0) {
        bestDeal = this.findBestDealByMonthSeason(flightPrices, monthSeasonMap, seasonType as 'low' | 'normal' | 'high');
      } else {
        bestDeal = this.findBestDeal(flightPrices, seasonType as 'high' | 'normal' | 'low');
      }

      return {
        type: seasonType as 'high' | 'normal' | 'low',
        months,
        priceRange: {
          min: minPrice,
          max: maxPrice,
        },
        bestDeal,
        description: this.getSeasonDescription(seasonType as 'high' | 'normal' | 'low'),
      };
    });
  }

  
}