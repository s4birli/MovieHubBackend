import express, { Response, Router, NextFunction } from "express";
import axios from "axios";
import MovieList from "../models/MovieList";
import { TMDBResponse, TMDBResult, TMDB_GENRES } from "../models/TMDBTypes";
import { MovieListQuery, AuthRequest, CustomRequestHandler } from "../models/types";

// SearchRequestHandler tipini güncelle
type SearchRequestHandler = CustomRequestHandler<any, any, any, { query?: string }>;

const router: Router = express.Router();

// Film arama endpoint'i
const searchMovies: SearchRequestHandler = async (req, res) => {
    try {
        const { query } = req.query;

        if (!query) {
            res.status(400).json({ message: "Arama sorgusu gerekli" });
            return;
        }

        const response = await axios.get<TMDBResponse>(`https://api.themoviedb.org/3/search/multi`, {
            params: {
                query,
                api_key: process.env.MOVIE_DB_API_KEY
            }
        });

        const results = response.data.results || [];

        const processedResults = results
            .filter((item: TMDBResult) => item.media_type === "movie" || item.media_type === "tv")
            .map((item: TMDBResult) => ({
                tmdbId: item.id,
                title: item.title || item.name,
                originalTitle: item.original_title || item.original_name,
                year: item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0],
                endYear: item.media_type === "tv" ? item.last_air_date?.split('-')[0] : undefined,
                mediaType: item.media_type,
                posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
                backdropPath: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
                overview: item.overview,
                voteAverage: item.vote_average,
                voteCount: item.vote_count,
                popularity: item.popularity,
                originalLanguage: item.original_language,
                genres: item.genre_ids.map(id => TMDB_GENRES[id]).filter(Boolean)
            }));

        res.json(processedResults);
    } catch (error) {
        console.error("Film arama hatası:", error);
        res.status(500).json({ message: "Film arama sırasında bir hata oluştu" });
    }
};

// Kullanıcının film listesini getir
const getMovieList: CustomRequestHandler = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            genres,
            mediaType,
            status,
            sortBy = 'title',
            sortOrder = 'asc'
        } = req.query as unknown as MovieListQuery;

        // Temel sorgu
        const query: any = {
            user: req.user?.id,
            isActive: true
        };

        // Filtreler
        if (genres) {
            query.genres = { $in: Array.isArray(genres) ? genres : [genres] };
        }
        if (mediaType) {
            query.mediaType = mediaType;
        }
        if (status) {
            query.status = status;
        }

        // Sıralama
        const sortOptions: { [key: string]: any } = {
            title: { title: sortOrder },
            rating: { voteAverage: sortOrder },
            year: { year: sortOrder }
        };

        // Toplam kayıt sayısı
        const total = await MovieList.countDocuments(query);

        // Sayfalama ve sıralama ile verileri getir
        const movies = await MovieList.find(query)
            .sort(sortOptions[sortBy] || sortOptions.title)
            .skip((page - 1) * limit)
            .limit(limit);

        res.json({
            movies,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error("Film listesi getirme hatası:", error);
        res.status(500).json({ message: "Film listesi getirilirken hata oluştu" });
    }
};

// Filme listesine film ekle
const addMovie: CustomRequestHandler = async (req, res) => {
    try {
        const movieData = {
            ...req.body,
            user: req.user?.id
        };

        const existingMovie = await MovieList.findOne({
            user: req.user?.id,
            tmdbId: movieData.tmdbId
        });

        if (existingMovie) {
            return res.status(400).json({ message: "Bu film zaten listenizde mevcut" });
        }

        // Zorunlu alanların kontrolü
        const requiredFields = ['tmdbId', 'title', 'mediaType'];
        for (const field of requiredFields) {
            if (!movieData[field]) {
                return res.status(400).json({ message: `${field} alanı zorunludur` });
            }
        }

        // Geçerli mediaType kontrolü
        if (!['movie', 'tv'].includes(movieData.mediaType)) {
            return res.status(400).json({ message: "Geçersiz mediaType değeri" });
        }

        const movie = new MovieList({
            ...movieData,
            status: movieData.status || 'plan-to-watch',
            createdAt: new Date(),
            updatedAt: new Date()
        });

        await movie.save();
        res.status(201).json(movie);
    } catch (error) {
        console.error("Film ekleme hatası:", error);
        res.status(500).json({ message: "Film eklenirken hata oluştu" });
    }
};

// Film güncelle (izlendi durumu)
const updateMovie: CustomRequestHandler = async (req, res) => {
    try {
        // Sadece status güncellenebilir
        const allowedUpdates = ['status'];

        // İzin verilmeyen alanları filtrele
        const updates = Object.keys(req.body)
            .filter(key => allowedUpdates.includes(key))
            .reduce((obj, key) => {
                obj[key] = req.body[key];
                return obj;
            }, {} as Record<string, any>);

        // Status değerinin geçerliliğini kontrol et
        if (updates.status && !['watching', 'completed', 'plan-to-watch'].includes(updates.status)) {
            res.status(400).json({ message: "Geçersiz status değeri" });
            return;
        }

        // Güncelleme zamanını ekle
        updates.updatedAt = new Date();

        const movie = await MovieList.findOneAndUpdate(
            { _id: req.params.id, user: req.user?.id, isActive: true },
            { $set: updates },
            { new: true, runValidators: true }
        );

        if (!movie) {
            res.status(404).json({ message: "Film bulunamadı" });
            return;
        }

        res.json(movie);
    } catch (error) {
        console.error("Film güncelleme hatası:", error);
        res.status(500).json({ message: "Film güncellenirken hata oluştu" });
    }
};

// Filmi listeden kaldır (soft delete)
const removeMovie: CustomRequestHandler = async (req, res) => {
    try {
        const movie = await MovieList.findOneAndUpdate(
            { _id: req.params.id, user: req.user?.id, isActive: true },
            { $set: { isActive: false, updatedAt: new Date() } },
            { new: true }
        );

        if (!movie) {
            res.status(404).json({ message: "Film bulunamadı" });
            return;
        }

        res.json({ message: "Film başarıyla kaldırıldı" });
    } catch (error) {
        res.status(500).json({ message: "Film kaldırılırken hata oluştu" });
    }
};

router.get("/search", searchMovies);
router.get("/list", getMovieList);
router.post("/list", addMovie);
router.put("/list/:id", updateMovie);
router.delete("/list/:id", removeMovie);

export default router; 