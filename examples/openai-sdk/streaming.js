// Example of using OpenAI SDK with proxy for Qwen AI in streaming mode
// Installation: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key',
});

async function streamFromQwen() {
    try {
        console.log('Sending streaming request to Qwen AI...\n');


        const stream = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Write a short story about a space adventure' }
            ],
            model: 'qwen-max-latest',
            stream: true,
        });

        console.log('Response from Qwen (streaming mode):\n');

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            process.stdout.write(content);
        }

        console.log('\nStreaming response completed.');

    } catch (error) {
        console.error('Error executing streaming request:', error);
    }
}

// Run
streamFromQwen();
