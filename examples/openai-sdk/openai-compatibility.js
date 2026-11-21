// Example demonstrating compatibility with OpenAI API
// Installation: npm install openai

import OpenAI from 'openai';

// Configure OpenAI client using our proxy as access point
const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Not used but required for SDK
});

async function openaiCompatibilityExample() {
    try {
        console.log('Demonstrating compatibility with OpenAI API\n');

        // 1. Standard request in OpenAI format
        console.log('1. Standard request in OpenAI format...');

        const completion = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [
                { role: 'system', content: 'You are a helpful assistant who gives clear and concise answers.' },
                { role: 'user', content: 'What is artificial intelligence?' }
            ],
            temperature: 0.7,
        });

        console.log('Response:');
        console.log(completion.choices[0].message.content);

        // 2. Streaming request in OpenAI format
        console.log('\n2. Streaming request in OpenAI format...');

        console.log('Response (streaming mode):');
        const stream = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [
                { role: 'system', content: 'You are a helpful assistant who answers briefly.' },
                { role: 'user', content: 'List 5 of the most popular programming languages' }
            ],
            stream: true,
        });

        let streamedContent = '';
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            streamedContent += content;
            process.stdout.write(content);
        }
        console.log('\n');

        // 3. Demonstrate response structure in OpenAI format
        console.log('\n3. Response structure in OpenAI format:');

        const responseDemo = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [{ role: 'user', content: 'Hello!' }],
        });

        // Display response structure (without content message)
        const { choices, ...responseWithoutChoices } = responseDemo;
        console.log(JSON.stringify({
            ...responseWithoutChoices,
            choices: [{
                ...choices[0],
                message: { role: choices[0].message.role, content: '[content message shortened for brevity]' }
            }]
        }, null, 2));



    } catch (error) {
        console.error('Error executing example:', error);
    }
}

// Run
openaiCompatibilityExample();
