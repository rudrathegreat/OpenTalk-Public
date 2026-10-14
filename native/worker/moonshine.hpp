#pragma once
#include "moonshine-c-api.h"
#include <filesystem>
#include <stdexcept>
#define NOMINMAX
#include <windows.h>

// Load only bundled, app-local DLLs. Never search the current directory or PATH.
class Moonshine {
    HMODULE library = nullptr;
    int32_t transcriber = -1, stream = -1;
    bool timed = false;
    struct MappedAsset {
        HANDLE file = INVALID_HANDLE_VALUE, mapping = nullptr;
        const uint8_t *bytes = nullptr;
        uint64_t size = 0;
        ~MappedAsset() { if (bytes) UnmapViewOfFile(bytes); if (mapping) CloseHandle(mapping); if (file != INVALID_HANDLE_VALUE) CloseHandle(file); }
    };
    std::vector<std::unique_ptr<MappedAsset>> mappings;
    std::vector<const uint8_t *> model_bytes;
    std::vector<uint64_t> model_sizes;
    const char *filenames[9] = {"adapter.ort", "cross_kv.ort", "decoder_kv.ort", "encoder.ort", "frontend.model.ort", "frontend.weights.ort", "streaming_config.json", "tokenizer.bin", "decoder_kv_with_attention.ort"};
    std::vector<int16_t> accepted;
    std::vector<float> floats;
#define API(name) decltype(&moonshine_##name) name = nullptr
    API(load_transcriber_from_memory_files); API(free_transcriber); API(create_stream);
    API(start_stream); API(stop_stream); API(free_stream);
    API(transcribe_add_audio_to_stream); API(transcribe_stream);
#undef API
    void reset() {
        if (stream >= 0) free_stream(transcriber, stream);
        stream = -1; std::fill(accepted.begin(), accepted.end(), 0); accepted.clear();
        std::fill(floats.begin(), floats.end(), 0.0f); floats.clear();
    }
    void load(bool timestamps) {
        if (transcriber >= 0) free_transcriber(transcriber);
        transcriber = -1;
        // Cache audio between draft updates; EOS still forces complete residual analysis.
        const moonshine_option_t options[] = {{"ort_providers", "CPU"}, {"word_timestamps", timestamps ? "true" : "false"}, {"identify_speakers", "false"}, {"log_ort_run", "false"}, {"log_output_text", "false"}, {"return_audio_data", "false"}, {"log_api_calls", "false"}, {"transcription_interval", "1.0"}};
        transcriber = load_transcriber_from_memory_files(filenames, model_bytes.data(), model_sizes.data(), 9, MOONSHINE_MODEL_ARCH_SMALL_STREAMING, options, 8, MOONSHINE_HEADER_VERSION);
        if (transcriber < 0) throw std::runtime_error("model_load");
        timed = timestamps;
    }
    static void append(std::string &result, const char *text) {
        if (!text) return;
        const size_t size = strnlen(text, 192001);
        if (size > 192000 || result.size() + size + 1 > 192000) throw std::runtime_error("transcript_size");
        if (size && !result.empty() && result.back() != ' ' && text[0] != ' ') result += ' ';
        result.append(text, size);
    }
public:
    explicit Moonshine(const char *path) {
        // Open verified model assets through UTF-16 Windows APIs; the library sees only
        // read-only mappings. This avoids its narrow-fopen Unicode/verbatim-path limitation.
        const auto root = std::filesystem::u8path(path);
        for (const char *name : filenames) {
            auto asset = std::make_unique<MappedAsset>();
            const auto filename = root / name;
            asset->file = CreateFileW(filename.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            LARGE_INTEGER size;
            if (asset->file == INVALID_HANDLE_VALUE || !GetFileSizeEx(asset->file, &size) || size.QuadPart <= 0 || size.QuadPart > 128 * 1024 * 1024) throw std::runtime_error("model_asset");
            asset->size = static_cast<uint64_t>(size.QuadPart);
            asset->mapping = CreateFileMappingW(asset->file, nullptr, PAGE_READONLY, 0, 0, nullptr);
            if (!asset->mapping) throw std::runtime_error("model_mapping");
            asset->bytes = static_cast<const uint8_t *>(MapViewOfFile(asset->mapping, FILE_MAP_READ, 0, 0, 0));
            if (!asset->bytes) throw std::runtime_error("model_mapping");
            model_bytes.push_back(asset->bytes); model_sizes.push_back(asset->size); mappings.push_back(std::move(asset));
        }
        wchar_t executable[32768];
        const auto size = GetModuleFileNameW(nullptr, executable, 32768);
        if (!size || size >= 32768) throw std::runtime_error("library_path");
        const auto dll = std::filesystem::path(executable).parent_path() / L"moonshine.dll";
        library = LoadLibraryExW(dll.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!library) throw std::runtime_error("library_load");
#define LOAD(name) name = reinterpret_cast<decltype(name)>(GetProcAddress(library, "moonshine_" #name)); if (!name) throw std::runtime_error("library_api")
        LOAD(load_transcriber_from_memory_files); LOAD(free_transcriber); LOAD(create_stream);
        LOAD(start_stream); LOAD(stop_stream); LOAD(free_stream);
        LOAD(transcribe_add_audio_to_stream); LOAD(transcribe_stream);
#undef LOAD
        load(false);
        accepted.reserve(MAX_SAMPLES); floats.reserve(MAX_SAMPLES);
    }
    ~Moonshine() { reset(); if (transcriber >= 0) free_transcriber(transcriber); if (library) FreeLibrary(library); }
    int recognize(const Task &task, Cancellation *cancel, std::string &result) {
        if (cancel && aborted(cancel)) return 1;
        if (task.pcm.size() < accepted.size() || !std::equal(accepted.begin(), accepted.end(), task.pcm.begin())) return 2;
        // Alignment is necessary only for the existing long-session overlap, not live short drafts.
        if (task.overlap && !timed) { if (stream >= 0) return 2; load(true); }
        if (stream < 0) {
            stream = create_stream(transcriber, 0);
            if (stream < 0 || start_stream(transcriber, stream) != 0) return 2;
        }
        // Full-prefix IPC is bounded; the engine sees each new sample exactly once.
        transcript_t *transcript = nullptr;
        while (accepted.size() < task.pcm.size()) {
            if (cancel && aborted(cancel)) return 1;
            // Bound uninterruptible library calls even if capture temporarily outruns inference.
            const size_t start = accepted.size(), count = std::min<size_t>(4000, task.pcm.size() - start);
            floats.resize(count);
            for (size_t i = 0; i < count; ++i) floats[i] = task.pcm[start + i] / 32768.0f;
            if (transcribe_add_audio_to_stream(transcriber, stream, floats.data(), count, 16000, 0) != 0) return 2;
            accepted.insert(accepted.end(), task.pcm.begin() + start, task.pcm.begin() + start + count);
            if (transcribe_stream(transcriber, stream, 0, &transcript) != 0) return 2;
        }
        if (task.kind == 2 && stop_stream(transcriber, stream) != 0) return 2;
        // Stop then transcribe drains every remaining sample, including sub-200 ms tails.
        if ((task.kind == 2 || !transcript) && transcribe_stream(transcriber, stream, 0, &transcript) != 0) return 2;
        if (!transcript || transcript->line_count > MAX_SAMPLES) return 2;
        for (uint64_t i = 0; i < transcript->line_count; ++i) {
            const auto &line = transcript->lines[i];
            if (task.kind == 2 && !line.is_complete) return 2;
            if (!task.overlap || line.start_time >= task.overlap / 100.0f) append(result, line.text);
            else {
                // Timestamp-based removal of the long-session one-second overlap.
                if (line.text && *line.text && (!line.words || !line.word_count)) return 2;
                if (line.word_count > MAX_SAMPLES) return 2;
                for (uint64_t w = 0; w < line.word_count; ++w)
                    if (line.words[w].end > task.overlap / 100.0f) append(result, line.words[w].text);
            }
        }
        if (task.kind == 2) { reset(); if (timed) load(false); }
        // A canceled preview may have advanced caches: keep the accepted watermark for final drain.
        return cancel && aborted(cancel) ? 1 : 0;
    }
};
