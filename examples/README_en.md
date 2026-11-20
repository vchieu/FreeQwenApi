# FreeQwenApi Usage Examples

> 🌐 **English** | [Русский](README.md) | [Tiếng Việt](README_vi.md)

This directory contains examples of using the API proxy for Qwen AI.

## Installation and Running

Dependencies are installed in the project root directory:

```bash
# In the project root directory
npm install
```

Before running examples, make sure the FreeQwenApi server is running and available at `http://localhost:3264`.

```bash
# Start the server
npm start

# In a separate terminal, run examples
npm run example:simple
npm run example:stream
# etc.
```

## Examples Using OpenAI SDK

### 1. Simple Request (non-streaming)

```bash
npm run example:simple
```

Demonstrates sending a simple request to Qwen AI using OpenAI SDK.

### 2. Streaming Request

```bash
npm run example:stream
```

Shows how to receive responses in streaming mode, where tokens arrive as they are generated.

### 3. Request with System Message

```bash
npm run example:system
```

Example of using a system message to set the role and instructions for the model.

### 4. Image Analysis

```bash
npm run example:image
```

Demonstration of sending an image for model analysis (requires replacing the image URL in the example).

### 5. Multi-message Conversation

```bash
npm run example:conversation
```

Example of maintaining a multi-message conversation with context preservation.

### 6. OpenAI API Compatibility

```bash
npm run example:compatibility
```

Demonstration of full compatibility with OpenAI API format.

## Direct API Usage Examples

### 1. Request Using fetch

```bash
npm run example:direct
```

Example of sending a direct API request without using SDK, using native fetch.

### 2. Request Using axios

```bash
npm run example:axios
```

Example of using the axios library to send API requests.

## Content Generation Tests

### Test All Generation Types

```bash
npm run test:features
```

Tests all three modes: text chat (t2t), image generation (t2i), and video generation (t2v).

### Compare Video Polling Modes

```bash
npm run test:video-polling
```

Compares server-side polling (server waits) and client-side polling (client polls manually).

> Detailed documentation on image and video generation: [IMAGE_VIDEO_GENERATION_GUIDE_en.md](../IMAGE_VIDEO_GENERATION_GUIDE_en.md)

## Modifying Examples

You can modify examples for your needs:

1. Change requests and parameters in example files
2. Try different models (list available via `/api/models`)
3. Experiment with different request formats

## Python Examples

Python proxy implementation runs a server with the same OpenAI-compatible endpoints:
- `POST /api/chat/completions`
- `POST /api/v1/chat/completions`
- `POST /api/chat`

Running:
```bash
pip install -r requirements.txt
python main.py
```

After running, you can use the same curl/OpenAI SDK examples from this directory, just point `base_url` to `http://localhost:3264/api`.

### Python OpenAI SDK Examples

Install dependencies:
```bash
pip install openai
```

Running:
```bash
python examples/python-sdk/simple.py
python examples/python-sdk/streaming.py
python examples/python-sdk/system_message.py
python examples/python-sdk/image_analysis.py
python examples/python-sdk/conversation.py
python examples/python-sdk/openai_compatibility.py
```

### Python direct API examples (httpx)

Install dependencies:
```bash
pip install httpx
```

Running:
```bash
python examples/python-direct/httpx_example.py
python examples/python-direct/httpx_streaming.py
```

## Working with Images

For image examples, you need to:

1. Upload an image in the official Qwen web interface
2. Get the image URL from network requests (see instructions in the main project's README.md)
3. Replace `IMAGE_URL` in the example with the obtained URL

## Additional Information

Detailed API documentation is available in the main project's README.md.
