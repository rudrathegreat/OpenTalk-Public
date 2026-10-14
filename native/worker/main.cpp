#include "whisper.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <io.h>

constexpr uint32_t MAX_SAMPLES = 30 * 16000;
static bool read_bytes(void *data, size_t bytes) { return fread(data, 1, bytes, stdin) == bytes; }
static bool write_bytes(const void *data, size_t bytes) { return fwrite(data, 1, bytes, stdout) == bytes; }
static void quiet(enum ggml_log_level, const char *, void *) {}

struct Task {
    uint32_t kind = 0, id = 0, overlap = 0;
    uint64_t epoch = 0;
    std::vector<int16_t> pcm;
};
struct Controls {
    std::mutex mutex;
    std::condition_variable changed;
    std::optional<Task> pending;
    std::atomic<uint64_t> epoch{0};
    std::atomic<bool> closed{false}, failed{false};
};
struct Cancellation { Controls *controls; uint64_t epoch; bool preview; };
static bool aborted(void *raw) {
    const auto &cancel = *static_cast<Cancellation *>(raw);
    return cancel.controls->failed.load() || (cancel.preview &&
        (cancel.controls->closed.load() || cancel.controls->epoch.load() != cancel.epoch));
}

#include "moonshine.hpp"

// OTW2: [kind,id,sampleCount,overlapHundredths] + PCM. Kind 3 cancels previews.
// Responses: [id,status,UTF8Length] + text; status 1 is expected preview abortion.
// The reader stays responsive while whisper_full runs on the inference thread.
static void read_controls(Controls &controls) {
    uint32_t header[4];
    while (read_bytes(header, sizeof(header))) {
        const auto kind = header[0], count = header[2];
        if (kind == 3 && count == 0 && header[3] == 0) {
            controls.epoch.fetch_add(1);
            controls.changed.notify_all();
            continue;
        }
        if ((kind != 1 && kind != 2) || header[1] == 0 || count == 0 || count > MAX_SAMPLES || header[3] > 100) {
            controls.failed.store(true); break;
        }
        Task task{kind, header[1], header[3], controls.epoch.load(), std::vector<int16_t>(count)};
        if (!read_bytes(task.pcm.data(), count * sizeof(int16_t))) { controls.failed.store(true); break; }
        {
            std::lock_guard<std::mutex> lock(controls.mutex);
            if (controls.pending) { controls.failed.store(true); break; }
            controls.pending = std::move(task);
        }
        controls.changed.notify_one();
    }
    controls.closed.store(true);
    controls.changed.notify_all();
}

static int recognize(whisper_context *context, const Task &task, unsigned threads,
                     std::vector<float> &audio, Cancellation *cancel, std::string &result) {
    audio.resize(task.pcm.size()); double energy = 0;
    for (size_t i = 0; i < task.pcm.size(); ++i) {
        audio[i] = task.pcm[i] / 32768.0f; energy += audio[i] * audio[i];
    }
    if (cancel && aborted(cancel)) return 1;
    // Preserve the existing silence gate and quality settings, including full audio context.
    if (std::sqrt(energy / audio.size()) < 0.003) return 0;
    auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = threads;
    params.language = "en"; params.translate = false; params.no_context = true;
    params.print_realtime = false; params.print_progress = false; params.print_timestamps = false; params.print_special = false;
    params.token_timestamps = true; params.split_on_word = true; params.suppress_blank = true; params.suppress_nst = true;
    if (cancel) { params.abort_callback = aborted; params.abort_callback_user_data = cancel; }
    const int status = whisper_full(context, params, audio.data(), static_cast<int>(audio.size()));
    if (cancel && aborted(cancel)) return 1;
    if (status != 0) return 2;
    for (int segment = 0; segment < whisper_full_n_segments(context); ++segment) {
        for (int token = 0; token < whisper_full_n_tokens(context, segment); ++token) {
            auto data = whisper_full_get_token_data(context, segment, token);
            if (data.id >= whisper_token_eot(context)) continue;
            if (task.overlap && data.t1 >= 0 && data.t1 <= task.overlap) continue;
            const char *text = whisper_full_get_token_text(context, segment, token);
            if (text) result += text;
        }
    }
    return result.size() <= 192000 ? 0 : 2;
}

static int run(int argc, char **argv) {
    if (argc < 3 || std::string(argv[1]) != "--model") return 2;
    bool ready = false, streaming = false;
    unsigned threads = std::min(8u, std::max(1u, std::thread::hardware_concurrency()));
    for (int i = 3; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--ready") ready = true;
        else if (arg == "--stream") { ready = true; streaming = true; }
        else if (arg == "--threads" && i + 1 < argc) {
            const std::string value = argv[++i];
            if (value != "2" && value != "4" && value != "6" && value != "8") return 2;
            threads = std::min(static_cast<unsigned>(std::stoi(value)), std::max(1u, std::thread::hardware_concurrency()));
        } else return 2;
    }
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    whisper_log_set(quiet, nullptr);
    auto config = whisper_context_default_params(); config.use_gpu = false;
    std::unique_ptr<Moonshine> moonshine;
    whisper_context *context = nullptr;
    try {
        if (std::filesystem::is_directory(std::filesystem::u8path(argv[2]))) moonshine = std::make_unique<Moonshine>(argv[2]);
        else context = whisper_init_from_file_with_params(argv[2], config);
    } catch (...) { return 3; }
    if (!context && !moonshine) return 3;
    if (ready && (!write_bytes(streaming ? "OTW2" : "OTW1", 4) || fflush(stdout) != 0)) { if (context) whisper_free(context); return 4; }
    std::vector<float> audio; audio.reserve(MAX_SAMPLES);
    int exit_status = 0;
    if (streaming) {
        Controls controls;
        std::thread reader([&] { read_controls(controls); });
        for (;;) {
            Task task;
            {
                std::unique_lock<std::mutex> lock(controls.mutex);
                controls.changed.wait(lock, [&] { return controls.pending || controls.closed.load(); });
                if (controls.failed.load() || (!controls.pending && controls.closed.load())) break;
                task = std::move(*controls.pending); controls.pending.reset();
            }
            Cancellation cancel{&controls, task.epoch, task.kind == 1};
            std::string result;
            int status;
            try { status = moonshine ? moonshine->recognize(task, &cancel, result) : recognize(context, task, threads, audio, &cancel, result); }
            catch (...) { status = 2; }
            if (status != 0) result.clear();
            const uint32_t header[]{task.id, static_cast<uint32_t>(status), static_cast<uint32_t>(result.size())};
            if (!write_bytes(header, sizeof(header)) || !write_bytes(result.data(), result.size()) || fflush(stdout) != 0 || status == 2) {
                // Do not join a reader blocked on stdin after fatal output/inference failure.
                std::exit(5);
            }
        }
        reader.join(); exit_status = controls.failed.load() ? 4 : 0;
    } else {
        // Legacy OTW1 remains available for public-fixture tooling.
        uint32_t count, overlap;
        while (read_bytes(&count, sizeof(count))) {
            if (!read_bytes(&overlap, sizeof(overlap)) || count == 0 || count > MAX_SAMPLES || overlap > 100) { exit_status = 4; break; }
            Task task{2, 0, overlap, 0, std::vector<int16_t>(count)};
            if (!read_bytes(task.pcm.data(), count * sizeof(int16_t))) { exit_status = 4; break; }
            std::string result;
            int status;
            try { status = moonshine ? moonshine->recognize(task, nullptr, result) : recognize(context, task, threads, audio, nullptr, result); }
            catch (...) { status = 2; }
            if (status != 0) { exit_status = 5; break; }
            const uint32_t length = static_cast<uint32_t>(result.size());
            if (!write_bytes(&length, sizeof(length)) || !write_bytes(result.data(), result.size()) || fflush(stdout) != 0) break;
        }
    }
    if (context) whisper_free(context); return exit_status;
}

// Preserve Unicode Windows profile/model paths when passing UTF-8 to either engine.
int wmain(int argc, wchar_t **wide) {
    std::vector<std::string> arguments; arguments.reserve(argc);
    for (int i = 0; i < argc; ++i) {
        const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1, nullptr, 0, nullptr, nullptr);
        if (size <= 0) return 2;
        std::string value(size, '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1, value.data(), size, nullptr, nullptr) != size) return 2;
        value.pop_back(); arguments.push_back(std::move(value));
    }
    std::vector<char *> pointers; pointers.reserve(argc);
    for (auto &argument : arguments) pointers.push_back(argument.data());
    return run(argc, pointers.data());
}
