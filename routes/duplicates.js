import express from 'express';
import { PrismaClient } from '@prisma/client';
import stringSimilarity from 'string-similarity';

const router = express.Router();
const prisma = new PrismaClient();
const similarityCache = new Map();

// Helper function to calculate similarity between two strings
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const cacheKey = `${str1}||${str2}`;
  if (similarityCache.has(cacheKey)) {
    return similarityCache.get(cacheKey);
  }
  
  const similarity = stringSimilarity.compareTwoStrings(
    str1.toLowerCase().trim(),
    str2.toLowerCase().trim()
  );
  
  similarityCache.set(cacheKey, similarity);
  return similarity;
}

function calculateAuthorsSimilarity(authors1, authors2) {
  if (!authors1?.length || !authors2?.length) return 0;
  
  // If both have no authors, consider it neutral (not 0, not 1)
  if (authors1.length === 0 && authors2.length === 0) return 0.5;
  
  const names1 = authors1.map(a => normalizeAuthorName(a.name)).filter(name => name.length > 1);
  const names2 = authors2.map(a => normalizeAuthorName(a.name)).filter(name => name.length > 1);
  
  if (names1.length === 0 || names2.length === 0) return 0;
  
  let matches = 0;
  const usedIndices = new Set();
  
  // Find best matches
  for (let i = 0; i < names1.length; i++) {
    let bestMatchIndex = -1;
    let bestMatchScore = 0;
    
    for (let j = 0; j < names2.length; j++) {
      if (usedIndices.has(j)) continue;
      
      const similarity = calculateSimilarity(names1[i], names2[j]);
      if (similarity > bestMatchScore) {
        bestMatchScore = similarity;
        bestMatchIndex = j;
      }
    }
    
    // Use flexible matching threshold
    if (bestMatchIndex !== -1 && bestMatchScore > 0.6) {
      matches++;
      usedIndices.add(bestMatchIndex);
    }
  }
  
  const similarityScore = matches / Math.max(names1.length, names2.length);
  return similarityScore;
}
// Calculate year similarity
function calculateYearSimilarity(date1, date2) {
  if (!date1 || !date2) return 0;
  
  const year1 = new Date(date1).getFullYear();
  const year2 = new Date(date2).getFullYear();
  
  if (year1 === year2) return 1;
  if (Math.abs(year1 - year2) <= 1) return 0.5;
  return 0;
}

// Helper function for exact DOI comparison
function areDOIsIdentical(doi1, doi2) {
  if (!doi1 || !doi2) return false;
  
  // Normalize DOIs by removing common variations
  const normalizeDOI = (doi) => {
    return doi
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\/doi\.org\//, '') // Remove DOI URL prefix
      .replace(/^doi:/, '') // Remove doi: prefix
      .replace(/\s+/g, '') // Remove whitespace
      .replace(/\.$/, ''); // Remove trailing dot
  };
  
  const norm1 = normalizeDOI(doi1);
  const norm2 = normalizeDOI(doi2);
  
  return norm1 === norm2;
}
// Performance monitoring
function startPerformanceMonitor() {
  const startTime = Date.now();
  let comparisons = 0;
  
  return {
    incrementComparisons: () => comparisons++,
    getStats: () => ({
      totalTime: Date.now() - startTime,
      totalComparisons: comparisons,
      comparisonsPerSecond: comparisons / ((Date.now() - startTime) / 1000)
    })
  };
}

// Better author name normalization
function normalizeAuthorName(name) {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ') // Normalize spaces
    .replace(/[^\w\s\.]/g, '') // Remove special chars
    .replace(/\b(\w)\w*\s+/g, '$1. ') // Convert to initials for better matching
    .trim();
}

// Calculate similarity scores for different fields
function calculateSimilarityScores(article1, article2) {
  // Check for exact DOI match first
  const exactDoiMatch = areDOIsIdentical(article1.doi, article2.doi);
  
  const scores = {
    title: calculateSimilarity(article1.title, article2.title),
    abstract: calculateSimilarity(article1.abstract || '', article2.abstract || ''),
    authors: calculateAuthorsSimilarity(article1.authors, article2.authors),
    journal: calculateSimilarity(article1.journal || '', article2.journal || ''),
    doi: exactDoiMatch ? 1.0 : calculateSimilarity(article1.doi || '', article2.doi || ''),
    year: calculateYearSimilarity(article1.date, article2.date)
  };

  // DEBUG: Log DOI information
  console.log('DOI Analysis:', {
    doi1: article1.doi,
    doi2: article2.doi,
    exactMatch: exactDoiMatch,
    similarity: scores.doi
  });

  // Calculate weighted overall score with better weights
  scores.overall = (
    scores.title * 0.35 +        // Title weight
    scores.abstract * 0.20 +     // Abstract weight
    scores.authors * 0.20 +      // Authors weight
    scores.journal * 0.05 +      // Journal weight
    scores.doi * 0.15 +          // Higher weight for DOI (since it's definitive)
    scores.year * 0.05
  );

  console.log(`Overall score: ${Math.round(scores.overall * 100)}%`);
  return scores;
}



// Calculate confidence score for duplicate group
function calculateConfidenceScore(similarArticles) {
  if (!similarArticles.length) return 0;
  const avgOverallScore = similarArticles.reduce((sum, item) => sum + item.scores.overall, 0) / similarArticles.length;
  return Math.min(100, Math.round(avgOverallScore * 100));
}

// DEBUGGING DUPLICATE DETECTION - FINDING THE MISSING PAIR
async function detectDuplicates(projectId) {
  console.log(`🔍 Starting DEBUG duplicate detection for project: ${projectId}`);
  
  similarityCache.clear();
  
  const articles = await prisma.article.findMany({
    where: { projectId },
    include: { authors: true }
  });

  console.log(`📚 Found ${articles.length} articles to analyze`);

  const duplicates = [];
  const processed = new Set();
  let comparisons = 0;

  // PHASE 1: DOI-based duplicates
  console.log('🔗 Phase 1: DOI-based exact matching...');
  const doiMap = new Map();
  
  for (const article of articles) {
    if (article.doi) {
      const normalizedDoi = normalizeDOI(article.doi);
      if (!doiMap.has(normalizedDoi)) doiMap.set(normalizedDoi, []);
      doiMap.get(normalizedDoi).push(article);
    }
  }

  for (const [doi, doiArticles] of doiMap) {
    if (doiArticles.length > 1) {
      const mainArticle = doiArticles[0];
      const similarArticles = doiArticles.slice(1).map(article => ({
        article,
        scores: { 
          title: calculateSimilarity(mainArticle.title, article.title),
          doi: 1.0,
          overall: 1.0 
        }
      }));

      duplicates.push({
        mainArticle,
        similarArticles,
        confidence: 100,
        reason: 'Exact DOI match'
      });

      doiArticles.forEach(article => processed.add(article.id));
      console.log(`✅ DOI DUPLICATE: ${doiArticles.length} articles with same DOI`);
    }
  }

  console.log(`✅ Found ${duplicates.length} DOI-based duplicate groups`);

  // PHASE 2: BRUTE-FORCE WITH DEBUGGING
  console.log('🎯 Phase 2: Brute-force comparison with debugging...');
  const remainingArticles = articles.filter(article => !processed.has(article.id));
  
  if (remainingArticles.length <= 1) {
    return duplicates;
  }

  // First, let's specifically look for the "Maternal and Fetal" pair
  console.log('\n🔍 SPECIFICALLY LOOKING FOR MATERNAL/FETAL PAIR:');
  const maternalArticles = remainingArticles.filter(article => 
    article.title.toLowerCase().includes('maternal and fetal') ||
    article.title.toLowerCase().includes('triplet pregnancy')
  );

  if (maternalArticles.length >= 2) {
    console.log(`🎯 Found ${maternalArticles.length} potential maternal/fetal articles`);
    maternalArticles.forEach((article, index) => {
      console.log(`   ${index + 1}. "${article.title}"`);
      console.log(`      Journal: ${article.journal}`);
      console.log(`      Date: ${article.date}`);
    });

    // Compare them specifically
    for (let i = 0; i < maternalArticles.length; i++) {
      for (let j = i + 1; j < maternalArticles.length; j++) {
        const title1 = maternalArticles[i].title;
        const title2 = maternalArticles[j].title;
        const similarity = calculateSimilarity(title1, title2);
        
        console.log(`\n🔍 COMPARING MATERNAL ARTICLES:`);
        console.log(`   Article 1: "${title1}"`);
        console.log(`   Article 2: "${title2}"`);
        console.log(`   Similarity: ${Math.round(similarity * 100)}%`);
        console.log(`   Lowercase 1: "${title1.toLowerCase()}"`);
        console.log(`   Lowercase 2: "${title2.toLowerCase()}"`);
        console.log(`   Are they equal? ${title1.toLowerCase() === title2.toLowerCase()}`);
        
        if (similarity > 0.8) {
          console.log(`✅ MATERNAL/FETAL DUPLICATE FOUND!`);
          if (!duplicates.some(d => d.mainArticle.id === maternalArticles[i].id)) {
            duplicates.push({
              mainArticle: maternalArticles[i],
              similarArticles: [{
                article: maternalArticles[j],
                scores: { title: similarity, overall: similarity }
              }],
              confidence: Math.round(similarity * 100),
              reason: 'Title similarity > 80%'
            });
            processed.add(maternalArticles[i].id);
            processed.add(maternalArticles[j].id);
          }
        }
      }
    }
  }

  // PHASE 3: BRUTE-FORCE FOR ALL OTHER ARTICLES
  console.log('\n🎯 Phase 3: Brute-force for all other articles...');
  const finalArticles = remainingArticles.filter(article => !processed.has(article.id));
  
  for (let i = 0; i < finalArticles.length; i++) {
    if (processed.has(finalArticles[i].id)) continue;

    const currentArticle = finalArticles[i];
    const similarArticles = [];

    for (let j = 0; j < finalArticles.length; j++) {
      if (i === j) continue;
      if (processed.has(finalArticles[j].id)) continue;

      comparisons++;
      const candidateArticle = finalArticles[j];
      const titleSimilarity = calculateSimilarity(currentArticle.title, candidateArticle.title);
      
      if (titleSimilarity > 0.8) {
        similarArticles.push({
          article: candidateArticle,
          scores: { title: titleSimilarity, overall: titleSimilarity }
        });
        processed.add(candidateArticle.id);
        
        console.log(`✅ DUPLICATE: "${currentArticle.title.substring(0, 50)}..."`);
        console.log(`   vs "${candidateArticle.title.substring(0, 50)}..."`);
        console.log(`   Similarity: ${Math.round(titleSimilarity * 100)}%`);
      }
    }

    if (similarArticles.length > 0) {
      duplicates.push({
        mainArticle: currentArticle,
        similarArticles: similarArticles,
        confidence: Math.round(similarArticles[0].scores.title * 100),
        reason: 'Title similarity > 80%'
      });
      processed.add(currentArticle.id);
    }
  }

  console.log(`🎯 Total: ${duplicates.length} duplicate groups found`);
  console.log(`📈 Statistics: ${comparisons} comparisons`);
  
  // Final summary
  console.log(`\n🔍 FINAL DUPLICATE PAIRS:`);
  duplicates.forEach((group, index) => {
    console.log(`\n   PAIR ${index + 1} (${group.confidence}%):`);
    console.log(`   • "${group.mainArticle.title}"`);
    console.log(`   • "${group.similarArticles[0].article.title}"`);
  });
  
  return duplicates;
}
// BETTER CLUSTERING TO CATCH MORE DUPLICATES
function createComprehensiveClusters(articles) {
  const clusters = new Map();
  
  articles.forEach(article => {
    // Create multiple cluster keys using different strategies
    
    // Strategy 1: First 4 words
    const key1 = article.title
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 4)
      .join(' ');
    
    // Strategy 2: First 5 words  
    const key2 = article.title
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 5)
      .join(' ');
    
    // Strategy 3: Keywords (remove common words)
    const key3 = extractImportantWords(article.title);
    
    // Strategy 4: First 6 characters (for very short comparisons)
    const key4 = article.title.toLowerCase().substring(0, 6);
    
    [key1, key2, key3, key4].forEach(key => {
      if (key && key.length > 5) { // Only use meaningful keys
        if (!clusters.has(key)) clusters.set(key, []);
        // Only add if not already in this cluster (avoid duplicates)
        if (!clusters.get(key).some(a => a.id === article.id)) {
          clusters.get(key).push(article);
        }
      }
    });
  });
  
  // Filter out clusters with only 1 article
  const filteredClusters = new Map();
  for (const [key, clusterArticles] of clusters) {
    if (clusterArticles.length > 1) {
      filteredClusters.set(key, clusterArticles);
    }
  }
  
  console.log(`📁 Created ${filteredClusters.size} comprehensive cluster groups`);
  return filteredClusters;
}

function extractImportantWords(title) {
  const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'as']);
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3 && !commonWords.has(word))
    .slice(0, 3)
    .join(' ');
}
function createArticleHash(article) {
  // Create a hash based on title + abstract for exact matching
  const title = article.title?.toLowerCase().trim().replace(/\s+/g, ' ') || '';
  const abstract = article.abstract?.toLowerCase().trim().replace(/\s+/g, ' ') || '';
  return `${title}||${abstract}`;
}

function createConservativeClusters(articles) {
  const clusters = new Map();
  
  articles.forEach(article => {
    // Only use first 4 words for clustering - less aggressive
    const key = article.title
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 4)
      .join(' ')
      .substring(0, 40);
    
    if (key.length > 15) { // Only meaningful keys
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(article);
    }
  });
  
  // Filter out clusters with only 1 article
  const filteredClusters = new Map();
  for (const [key, clusterArticles] of clusters) {
    if (clusterArticles.length > 1) {
      filteredClusters.set(key, clusterArticles);
    }
  }
  
  console.log(`📁 Created ${filteredClusters.size} conservative cluster groups`);
  return filteredClusters;
}// Helper function to create title fingerprint
function createTitleFingerprint(title) {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')    // Normalize spaces
    .split(' ')
    .slice(0, 5)             // First 5 words
    .sort()                  // Sort for consistency
    .join(' ')
    .substring(0, 50);       // Limit length
}

// Helper function to normalize DOI
function normalizeDOI(doi) {
  if (!doi) return '';
  return doi
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/doi\.org\//, '')
    .replace(/^doi:/, '')
    .replace(/\s+/g, '')
    .replace(/\.$/, '');
}

// OPTIMIZED DUPLICATE DETECTION LOGIC
// FIXED DUPLICATE DETECTION - NO AUTHOR REQUIREMENT
function isDuplicateOptimized(scores, article1, article2) {
  const titleSimilarity = scores.title;
  const authorsSimilarity = scores.authors;
  const abstractSimilarity = scores.abstract;

  console.log(`🔍 Checking: Title ${Math.round(titleSimilarity * 100)}%, Authors ${Math.round(authorsSimilarity * 100)}%, Abstract ${Math.round(abstractSimilarity * 100)}%`);

  // 1. SAME DOI - DEFINITIVE MATCH (already handled in Phase 1)
  if (scores.doi === 1.0) {
    console.log('✅ DUPLICATE: Same DOI');
    return true;
  }

  // 2. VERY HIGH TITLE SIMILARITY (90%+) - almost certainly duplicate regardless of authors
  if (titleSimilarity > 0.9) {
    console.log('✅ DUPLICATE: Very high title similarity (>90%) - authors not required');
    return true;
  }

  // 3. HIGH TITLE SIMILARITY (85-90%) with ANY supporting evidence
  if (titleSimilarity > 0.85) {
    if (abstractSimilarity > 0.4 || scores.journal > 0.7 || scores.year > 0.8) {
      console.log('✅ DUPLICATE: High title (85%+) with any supporting evidence');
      return true;
    }
  }

  // 4. GOOD TITLE SIMILARITY (80-85%) with reasonable evidence
  if (titleSimilarity >= 0.8) {
    // Abstract evidence
    if (abstractSimilarity > 0.5) {
      console.log('✅ DUPLICATE: Good title with abstract evidence');
      return true;
    }
    // Journal + year evidence
    if (scores.journal > 0.7 && scores.year > 0.7) {
      console.log('✅ DUPLICATE: Good title with journal+year evidence');
      return true;
    }
    // Similar DOI evidence
    if (scores.doi > 0.8) {
      console.log('✅ DUPLICATE: Good title with similar DOI');
      return true;
    }
  }

  // 5. MODERATE TITLE + STRONG MULTIPLE EVIDENCE (authors optional)
  if (titleSimilarity >= 0.75) {
    const evidencePoints = [
      abstractSimilarity > 0.6,
      scores.journal > 0.8,
      scores.year > 0.8,
      scores.doi > 0.7
    ].filter(Boolean).length;
    
    if (evidencePoints >= 2) {
      console.log('✅ DUPLICATE: Moderate title with multiple evidence points');
      return true;
    }
  }

  // 6. TITLE + ABSTRACT COMBINATION (authors completely optional)
  if (titleSimilarity >= 0.7 && abstractSimilarity > 0.7) {
    console.log('✅ DUPLICATE: Title + abstract combination');
    return true;
  }

  console.log('❌ Not duplicate - insufficient evidence');
  return false;
}
function isDuplicateSimple(scores, article1, article2) {
  const title = scores.title;
  const abstract = scores.abstract;
  const doi = scores.doi;

  console.log(`🔍 Simple: Title ${Math.round(title * 100)}%, Abstract ${Math.round(abstract * 100)}%`);

  // 1. Same DOI - definitive duplicate
  if (doi === 1.0) {
    console.log('✅ DUPLICATE: Same DOI');
    return true;
  }

  // 2. Very high title - almost certainly duplicate
  if (title > 0.9) {
    console.log('✅ DUPLICATE: Very high title (>90%)');
    return true;
  }

  // 3. High title + abstract >= 50%
  if (title > 0.85 && abstract >= 0.5) {
    console.log('✅ DUPLICATE: High title + abstract >= 50%');
    return true;
  }

  // 4. Good title + abstract >= 50%
  if (title >= 0.8 && abstract >= 0.5) {
    console.log('✅ DUPLICATE: Good title + abstract >= 50%');
    return true;
  }

  // 5. Moderate title + good abstract
  if (title >= 0.75 && abstract > 0.6) {
    console.log('✅ DUPLICATE: Moderate title + good abstract');
    return true;
  }

  // 6. Title + similar DOI
  if (title > 0.7 && doi > 0.8) {
    console.log('✅ DUPLICATE: Title + similar DOI');
    return true;
  }

  console.log('❌ Not duplicate');
  return false;
}
function isDuplicateTitleFocused(scores, article1, article2) {
  const title = scores.title;
  const abstract = scores.abstract || 0; // Handle missing abstracts

  console.log(`🔍 Title-Focused: Title ${Math.round(title * 100)}%, Abstract ${Math.round(abstract * 100)}%`);

  // Same DOI - always duplicate
  if (scores.doi === 1.0) return true;

  // Title-based rules (abstract just needs to be >= 50%)
  if (title > 0.9) return true; // Very high title
  if (title > 0.85 && abstract >= 0.5) return true; // High title
  if (title >= 0.8 && abstract >= 0.5) return true; // Good title
  if (title >= 0.75 && abstract > 0.6) return true; // Moderate title + better abstract

  return false;
}
// Calculate comprehensive quality score for an article
// Optimized quality score calculation
function calculateArticleQualityScore(article) {
  let score = 0;
  
  // DOI presence (20 points)
  if (article.doi) score += 20;
  
  // Abstract completeness (15 points)
  if (article.abstract && article.abstract.length > 50) score += 15;
  
  // Author count (10 points)
  if (article.authors?.length > 0) score += Math.min(article.authors.length * 2, 10);
  
  // Journal presence (10 points)
  if (article.journal) score += 10;
  
  // Recent publication (10 points)
  if (article.date) {
    const yearsAgo = new Date().getFullYear() - new Date(article.date).getFullYear();
    if (yearsAgo <= 5) score += 10;
  }
  
  return score;
}
// Resolve all duplicates automatically
// In your routes/duplicates.js - Update the resolveAllDuplicates function
async function resolveAllDuplicates(projectId, userId) {
  console.log(`🔄 Starting automatic resolution for project: ${projectId}`);
  
  // Get all articles for the project
  const articles = await prisma.article.findMany({
    where: { 
      projectId,
      duplicateStatus: null // Only consider unresolved articles
    },
    include: {
      authors: true,
    //   topics: true,
      publicationTypes: true
    }
  });

  console.log(`📚 Found ${articles.length} articles to analyze`);

  // Use existing duplicate detection results instead of re-detecting
  const latestDetection = await prisma.duplicateDetection.findFirst({
    where: { projectId },
    orderBy: { detectedAt: 'desc' }
  });

  let duplicateGroups = [];
  
  if (latestDetection && latestDetection.results) {
    // Use existing detection results
    console.log('✅ Using existing duplicate detection results');
    duplicateGroups = latestDetection.results.duplicates || latestDetection.results || [];
  } else {
    // Fallback: Quick duplicate detection only for high-confidence cases
    console.log('🔄 Running quick duplicate detection');
    duplicateGroups = await quickDetectDuplicates(articles);
  }

  console.log(`🎯 Found ${duplicateGroups.length} duplicate groups to resolve`);

  const resolutions = [];
  const articlesToKeep = new Set();
  const articlesToRemove = new Set();
  
  // Process each duplicate group
  for (const group of duplicateGroups) {
    const allArticlesInGroup = [
      group.mainArticle,
      ...(group.similarArticles || []).map(sa => sa.article)
    ].filter(Boolean); // Remove any null/undefined articles
    
    if (allArticlesInGroup.length < 2) continue; // Skip groups with less than 2 articles
    
    // Choose the best article to keep
    let bestArticle = allArticlesInGroup[0];
    
    for (const article of allArticlesInGroup) {
      const currentBestScore = calculateArticleQualityScore(bestArticle);
      const challengerScore = calculateArticleQualityScore(article);
      
      if (challengerScore > currentBestScore) {
        bestArticle = article;
      }
    }
    
    // Mark articles for keeping/removal
    articlesToKeep.add(bestArticle.id);
    
    for (const article of allArticlesInGroup) {
      if (article.id !== bestArticle.id) {
        articlesToRemove.add(article.id);
      }
    }
    
    resolutions.push({
      groupId: group.mainArticle?.id || 'unknown',
      articlesInGroup: allArticlesInGroup.map(a => ({ 
        id: a.id, 
        title: a.title,
        doi: a.doi,
        journal: a.journal 
      })),
      chosenArticle: { 
        id: bestArticle.id, 
        title: bestArticle.title,
        doi: bestArticle.doi,
        qualityScore: calculateArticleQualityScore(bestArticle)
      },
      reason: `Highest quality score (${calculateArticleQualityScore(bestArticle)})`
    });
  }
  
  // Convert sets to arrays
  const keepIds = Array.from(articlesToKeep);
  const removeIds = Array.from(articlesToRemove);
  
  console.log(`💾 Resolution plan: Keep ${keepIds.length}, Remove ${removeIds.length}`);
  
  // Update database - mark duplicates for removal
  if (removeIds.length > 0) {
    await prisma.article.updateMany({
      where: { 
        id: { in: removeIds },
        projectId 
      },
      data: { 
        duplicateStatus: 'duplicate',
        resolvedAt: new Date(),
        resolvedBy: userId
      }
    });
  }
  
  // Mark kept articles as resolved but not duplicates
  if (keepIds.length > 0) {
    await prisma.article.updateMany({
      where: { 
        id: { in: keepIds },
        projectId 
      },
      data: { 
        duplicateStatus: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: userId
      }
    });
  }
  
  // Count remaining articles after resolution
  const totalArticlesAfterResolution = await prisma.article.count({
    where: { 
      projectId,
      NOT: {
        duplicateStatus: 'duplicate'
      }
    }
  });

  console.log(`📊 After resolution: ${totalArticlesAfterResolution} articles remaining`);
  
  return {
    totalGroupsResolved: duplicateGroups.length,
    articlesKept: keepIds.length,
    articlesRemoved: removeIds.length,
    totalArticlesAfterResolution,
    resolutions: resolutions,
    summary: {
      initialArticleCount: articles.length,
      duplicateGroupsFound: duplicateGroups.length,
      articlesInDuplicateGroups: articlesToKeep.size + articlesToRemove.size,
      finalArticleCount: totalArticlesAfterResolution,
      reductionPercentage: removeIds.length > 0 ? ((removeIds.length / articles.length) * 100).toFixed(1) : '0'
    }
  };
}

// Add this quick detection function for fallback
// Optimized quick detection
async function quickDetectDuplicates(articles) {
  const duplicateGroups = [];
  const processed = new Set();
  const doiMap = new Map();

  // DOI-based duplicates only (fastest)
  for (const article of articles) {
    if (article.doi) {
      const normalizedDoi = article.doi.toLowerCase().trim().replace(/^https?:\/\/doi\.org\//, '').replace(/^doi:/, '');
      if (!doiMap.has(normalizedDoi)) doiMap.set(normalizedDoi, []);
      doiMap.get(normalizedDoi).push(article);
    }
  }

  for (const [doi, doiArticles] of doiMap) {
    if (doiArticles.length > 1) {
      const mainArticle = doiArticles[0];
      const similarArticles = doiArticles.slice(1).map(article => ({
        article,
        scores: { overall: 0.95 }
      }));

      duplicateGroups.push({
        mainArticle,
        similarArticles,
        confidence: 95
      });

      doiArticles.forEach(article => processed.add(article.id));
    }
  }

  return duplicateGroups;
}
// BALANCED DUPLICATE DETECTION
function isDuplicateBalanced(scores, article1, article2) {
  const title = scores.title;
  const abstract = scores.abstract;
  const doi = scores.doi;

  console.log(`🔍 Balanced: Title ${Math.round(title * 100)}%, Abstract ${Math.round(abstract * 100)}%`);

  // 1. EXACT MATCHES - These are definitely duplicates
  if (title === 1.0 && abstract === 1.0) {
    console.log('✅ DUPLICATE: Exact title and abstract match');
    return true;
  }

  if (doi === 1.0) {
    console.log('✅ DUPLICATE: Same DOI');
    return true;
  }

  // 2. VERY HIGH CONFIDENCE
  if (title > 0.95 && abstract > 0.7) {
    console.log('✅ DUPLICATE: Very high title + good abstract');
    return true;
  }

  if (title > 0.9 && abstract > 0.8) {
    console.log('✅ DUPLICATE: High title + strong abstract');
    return true;
  }

  // 3. HIGH CONFIDENCE
  if (title > 0.88 && abstract > 0.6) {
    console.log('✅ DUPLICATE: High title + decent abstract');
    return true;
  }

  if (title > 0.85 && abstract > 0.7) {
    console.log('✅ DUPLICATE: Good title + good abstract');
    return true;
  }

  // 4. MEDIUM CONFIDENCE (your expected cases)
  if (title > 0.8 && abstract > 0.5) {
    console.log('✅ DUPLICATE: Good title + reasonable abstract');
    return true;
  }

  if (title > 0.75 && abstract > 0.6) {
    console.log('✅ DUPLICATE: Moderate title + good abstract');
    return true;
  }

  // 5. SPECIAL CASE: Similar DOI with decent title
  if (title > 0.7 && doi > 0.8) {
    console.log('✅ DUPLICATE: Similar DOI + decent title');
    return true;
  }

  console.log('❌ Not duplicate');
  return false;
}
// Add this debug function to understand your data better
// Enhanced debug function
async function analyzeArticles(projectId) {
  const articles = await prisma.article.findMany({
    where: { projectId },
    include: { authors: true },
    take: 20 // Get more samples
  });

  console.log('\n🔍 DETAILED SAMPLE ANALYSIS:');
  articles.forEach((article, index) => {
    console.log(`${index + 1}. "${article.title}"`);
    console.log(`   Authors: ${article.authors.map(a => a.name).join(', ')}`);
    console.log(`   DOI: ${article.doi || 'None'}`);
    console.log(`   Journal: ${article.journal || 'None'}`);
    console.log(`   Abstract: ${article.abstract ? article.abstract.substring(0, 100) + '...' : 'None'}`);
    console.log('---');
  });

  // Check for obvious duplicates
  console.log('\n🔍 CHECKING FOR POTENTIAL DUPLICATES IN SAMPLE:');
  let potentialDupes = 0;
  
  for (let i = 0; i < Math.min(10, articles.length); i++) {
    for (let j = i + 1; j < Math.min(10, articles.length); j++) {
      const scores = calculateSimilarityScores(articles[i], articles[j]);
      
      if (scores.title > 0.7) { // Lower threshold for potential
        console.log(`\n📊 POTENTIAL: Article ${i+1} vs ${j+1}`);
        console.log(`   Title 1: "${articles[i].title.substring(0, 60)}..."`);
        console.log(`   Title 2: "${articles[j].title.substring(0, 60)}..."`);
        console.log(`   Scores - Title: ${Math.round(scores.title * 100)}%, Authors: ${Math.round(scores.authors * 100)}%, Abstract: ${Math.round(scores.abstract * 100)}%`);
        
        if (scores.title >= 0.8) {
          potentialDupes++;
          console.log(`   🎯 MEETS TITLE THRESHOLD - Check authors/abstract`);
        }
      }
    }
  }
  
  console.log(`\n📈 Found ${potentialDupes} potential duplicates in sample`);
}
// NEW ENDPOINT: Resolve all duplicates automatically
router.post('/projects/:projectId/resolve-all', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    console.log(`🚀 Starting bulk resolution for project: ${projectId}`);
    
    // Check project access
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        OR: [
          { ownerId: userId },
          { members: { some: { userId: userId } } }
        ]
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get initial article count
    const initialCount = await prisma.article.count({
      where: { projectId }
    });

    // Resolve all duplicates
    const resolutionResult = await resolveAllDuplicates(projectId, userId);

    // Create resolution record in duplicate detection table
    const resolutionRecord = await prisma.duplicateDetection.upsert({
      where: {
        projectId: projectId
      },
      update: {
        detectedAt: new Date(),
        totalGroups: resolutionResult.totalGroupsResolved,
        totalArticles: resolutionResult.totalArticlesAfterResolution,
        results: {
          ...resolutionResult,
          resolutionType: 'auto_resolve_all',
          resolvedAt: new Date(),
          resolvedBy: userId
        }
      },
      create: {
        projectId,
        detectedAt: new Date(),
        totalGroups: resolutionResult.totalGroupsResolved,
        totalArticles: resolutionResult.totalArticlesAfterResolution,
        results: {
          ...resolutionResult,
          resolutionType: 'auto_resolve_all',
          resolvedAt: new Date(),
          resolvedBy: userId
        }
      }
    });

    console.log(`✅ Bulk resolution completed successfully`);
    
    res.json({
      success: true,
      message: `Successfully resolved ${resolutionResult.totalGroupsResolved} duplicate groups`,
      data: {
        resolutionId: resolutionRecord.id,
        summary: resolutionResult.summary,
        resolutions: resolutionResult.resolutions,
        statistics: {
          initialArticles: initialCount,
          finalArticles: resolutionResult.totalArticlesAfterResolution,
          duplicatesRemoved: resolutionResult.articlesRemoved,
          reduction: `${resolutionResult.summary.reductionPercentage}% reduction`
        }
      }
    });

  } catch (error) {
    console.error('❌ Bulk resolution error:', error);
    res.status(500).json({ 
      error: 'Failed to resolve all duplicates',
      details: error.message 
    });
  }
});

// NEW ENDPOINT: Get resolution summary
router.get('/projects/:projectId/resolution-summary', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Check project access
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        OR: [
          { ownerId: userId },
          { members: { some: { userId: userId } } }
        ]
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get article counts by status
    const articleCounts = await prisma.article.groupBy({
      by: ['duplicateStatus'],
      where: { projectId },
      _count: {
        id: true
      }
    });

    // Get total articles
    const totalArticles = await prisma.article.count({
      where: { projectId }
    });

    // Get latest resolution
    const latestResolution = await prisma.duplicateDetection.findFirst({
      where: { projectId },
      orderBy: { detectedAt: 'desc' }
    });

    res.json({
      success: true,
      data: {
        totalArticles,
        statusBreakdown: articleCounts,
        latestResolution: latestResolution ? {
          resolvedAt: latestResolution.detectedAt,
          totalGroups: latestResolution.totalGroups,
          totalArticles: latestResolution.totalArticles
        } : null
      }
    });

  } catch (error) {
    console.error('Error fetching resolution summary:', error);
    res.status(500).json({ error: 'Failed to fetch resolution summary' });
  }
});
// POST /api/duplicates/projects/:projectId/detect
router.post('/projects/:projectId/detect', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        OR: [
          { ownerId: req.user.id },
          { members: { some: { userId: req.user.id } } }
        ]
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    console.log('🚀 Starting IMPROVED duplicate detection...');
    
    // First, do detailed analysis
    await analyzeArticles(projectId);
    
    const performanceMonitor = startPerformanceMonitor();
    console.time('Duplicate Detection');
    
    const duplicates = await detectDuplicates(projectId);
    
    console.timeEnd('Duplicate Detection');
    const stats = performanceMonitor.getStats();
    
    console.log(`\n📊 FINAL RESULTS:`);
    console.log(`   Duplicate groups: ${duplicates.length}`);
    console.log(`   Total comparisons: ${stats.totalComparisons}`);
    console.log(`   Detection time: ${stats.totalTime}ms`);
    console.log(`   Efficiency: ${Math.round((stats.comparisons / (stats.totalComparisons * 2)) * 100)}%`);

    // Save results
    const duplicateDetection = await prisma.duplicateDetection.upsert({
      where: { projectId },
      update: {
        detectedAt: new Date(),
        totalGroups: duplicates.length,
        totalArticles: duplicates.reduce((sum, group) => sum + group.similarArticles.length + 1, 0),
        results: duplicates
      },
      create: {
        projectId,
        detectedAt: new Date(),
        totalGroups: duplicates.length,
        totalArticles: duplicates.reduce((sum, group) => sum + group.similarArticles.length + 1, 0),
        results: duplicates
      }
    });

    res.json({
      success: true,
      duplicates,
      performance: {
        detectionTime: stats.totalTime,
        comparisons: stats.totalComparisons,
        efficiency: `${Math.round((stats.comparisons / (stats.totalComparisons * 2)) * 100)}%`
      },
      summary: {
        totalGroups: duplicates.length,
        totalArticles: duplicates.reduce((sum, group) => sum + group.similarArticles.length + 1, 0),
        detectionDate: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Duplicate detection error:', error);
    res.status(500).json({ error: 'Failed to detect duplicates' });
  }
});
// GET /api/duplicates/projects/:projectId
router.get('/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    // Check project access
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        OR: [
          { ownerId: req.user.id },
          { members: { some: { userId: req.user.id } } }
        ]
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const duplicates = await prisma.duplicateDetection.findFirst({
      where: { projectId },
      orderBy: { detectedAt: 'desc' }
    });

    if (!duplicates) {
      return res.json({ results: [] }); // Return empty array instead of error
    }

    res.json(duplicates);

  } catch (error) {
    console.error('Error fetching duplicates:', error);
    res.status(500).json({ error: 'Failed to fetch duplicate results' });
  }
});

// POST /api/duplicates/projects/:projectId/resolve
router.post('/projects/:projectId/resolve', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { articleIds, resolution } = req.body; // resolution: 'duplicate', 'not_duplicate'

    // Check project access
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        OR: [
          { ownerId: req.user.id },
          { members: { some: { userId: req.user.id } } }
        ]
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update articles with resolution
    await prisma.article.updateMany({
      where: { 
        id: { in: articleIds },
        projectId 
      },
      data: { 
        duplicateStatus: resolution,
        resolvedAt: new Date(),
        resolvedBy: req.user.id
      }
    });

    res.json({ success: true, message: 'Duplicates resolved successfully' });

  } catch (error) {
    console.error('Error resolving duplicates:', error);
    res.status(500).json({ error: 'Failed to resolve duplicates' });
  }
});

// Debug endpoint
router.get('/projects/:projectId/debug', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    const articles = await prisma.article.findMany({
      where: { projectId },
      include: { authors: true },
      take: 5 // Just get a few for testing
    });

    // Return article info for debugging
    const articleInfo = articles.map(article => ({
      id: article.id,
      title: article.title,
      authors: article.authors.map(a => a.name),
      journal: article.journal,
      doi: article.doi,
      date: article.date
    }));

    res.json({ articles: articleInfo, total: articles.length });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: 'Debug failed' });
  }
});

export default router;