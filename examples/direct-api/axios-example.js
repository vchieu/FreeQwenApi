// Example of direct API request to Qwen proxy using axios
// Installation: npm install axios
// To run the example: node axios-example.js

import axios from 'axios';

async function axiosExample() {
    try {
        console.log('Sending request via axios to Qwen API...\n');

        // Example with messages format, compatible with OpenAI
        const response = await axios.post('http://localhost:3264/api/chat', {
            messages: [
                { role: 'system', content: 'You are an expert in JavaScript programming.' },
                { role: 'user', content: 'Explain how asynchronous functions work in JavaScript' }
            ],
            model: 'qwen-max-latest'
        });

        console.log('Response from API:\n');
        console.log(response.data.choices[0].message.content);
        console.log('\nRequest successfully completed.');

        // Display additional information
        console.log('\nRequest info:');
        console.log(`Chat ID: ${response.data.chatId}`);
        console.log(`Model: ${response.data.model}`);

        // Save chat ID for the next example
        const chatId = response.data.chatId;

        // Continue dialog in the same chat
        console.log('\nSending second message to the same chat...\n');

        const followUpResponse = await axios.post('http://localhost:3264/api/chat', {
            message: 'Give an example of using async/await',
            model: 'qwen-max-latest',
            chatId: chatId
        });

        console.log('Response to second message:\n');
        console.log(followUpResponse.data.choices[0].message.content);

    } catch (error) {
        console.error('Error executing request:', error);
        if (error.response) {
            console.error('Error details:', error.response.data);
        }
    }
}

// Run
axiosExample();
